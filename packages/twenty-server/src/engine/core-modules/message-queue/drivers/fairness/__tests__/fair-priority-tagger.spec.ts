import { readFileSync } from 'node:fs';

import { Logger } from '@nestjs/common';

import { type Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { isDefined } from 'twenty-shared/utils';

import { FairPriorityTagger } from 'src/engine/core-modules/message-queue/drivers/fairness/fair-priority-tagger';
import {
  FAIR_REBASE_STEP,
  FAIR_REBASE_THRESHOLD,
  FAIR_TICKET_OFFSET,
  URGENT_FAIR_PRIORITY,
} from 'src/engine/core-modules/message-queue/drivers/fairness/fair-priority.constant';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';

const QUEUE = MessageQueue.logicFunctionQueue;
const KEY_PREFIX = 'bull';
const QUEUE_KEY_PREFIX = `${KEY_PREFIX}:${QUEUE}:`;
const VIRTUAL_TIME_KEY = `${QUEUE_KEY_PREFIX}fair:vtime`;
const BASE_KEY = `${QUEUE_KEY_PREFIX}fair:base`;
const REBASE_KEY = `${QUEUE_KEY_PREFIX}fair:rebase`;
const WEIGHTS_KEY = `${QUEUE_KEY_PREFIX}fair:weights`;
const PRIORITIZED_KEY = `${QUEUE_KEY_PREFIX}prioritized`;
const DELAYED_KEY = `${QUEUE_KEY_PREFIX}delayed`;
const ACTIVE_KEY = `${QUEUE_KEY_PREFIX}active`;
// BullMQ scores a prioritized job by priority * 2^32 + insertion counter
const PRIORITY_SCORE_BASE = 2 ** 32;
const BULLMQ_PRIORITY_SCORE_LUA =
  require.resolve('bullmq/dist/cjs/commands/includes/getPriorityScore.lua');
const THRESHOLD = FAIR_REBASE_THRESHOLD;
const STEP = FAIR_REBASE_STEP;

const ticketOf = (tag: number) => FAIR_TICKET_OFFSET + tag;

// ioredis-mock instances share one store, so each test starts from an empty one
const createTagger = async ({
  rebaseGraceMs = 0,
}: { rebaseGraceMs?: number } = {}) => {
  const redis: Redis = new RedisMock();

  await redis.flushall();

  const client = {
    runCommand: async (name: string, args: (string | number)[]) => {
      const [script, numberOfKeys, ...scriptArguments] = args;

      if (name === 'evalsha') {
        return redis.evalsha(
          String(script),
          Number(numberOfKeys),
          ...scriptArguments,
        );
      }

      if (name !== 'eval') {
        throw new Error(`Unexpected Redis command ${name}`);
      }

      return redis.eval(
        String(script),
        Number(numberOfKeys),
        ...scriptArguments,
      );
    },
  };
  // The base a ticket was reserved on sits in the job options, as the driver writes it, until a rebase stamps the hash
  const seedJob = async ({
    jobId,
    priority,
    counter,
    state,
    base = 0,
    stampedBase,
  }: {
    jobId: string;
    priority: number;
    counter: number;
    state: 'prioritized' | 'delayed' | 'active';
    base?: number | 'none';
    stampedBase?: number;
  }) => {
    const jobKey = `${QUEUE_KEY_PREFIX}${jobId}`;

    await redis.hset(jobKey, 'priority', priority);

    if (base !== 'none') {
      await redis.hset(
        jobKey,
        'opts',
        JSON.stringify({ priority, fairBase: base }),
      );
    }

    if (isDefined(stampedBase)) {
      await redis.hset(jobKey, 'fairBase', stampedBase);
    }

    if (state === 'prioritized') {
      await redis.zadd(
        PRIORITIZED_KEY,
        priority * PRIORITY_SCORE_BASE + counter,
        jobId,
      );
    } else if (state === 'delayed') {
      await redis.zadd(DELAYED_KEY, counter, jobId);
    } else {
      await redis.rpush(ACTIVE_KEY, jobId);
    }
  };

  return {
    redis,
    tagger: new FairPriorityTagger({
      getClient: async () => client as never,
      keyPrefix: KEY_PREFIX,
      rebaseGraceMs,
    }),
    seedJob,
    readClock: async (groupKey: string) => {
      const raw = await redis.get(`${QUEUE_KEY_PREFIX}fair:clock:${groupKey}`);

      return raw?.split(':').map(Number);
    },
    readPriority: async (jobId: string) =>
      Number(await redis.hget(`${QUEUE_KEY_PREFIX}${jobId}`, 'priority')),
    readStampedBase: async (jobId: string) => {
      const raw = await redis.hget(`${QUEUE_KEY_PREFIX}${jobId}`, 'fairBase');

      return isDefined(raw) ? Number(raw) : undefined;
    },
    readVirtualTime: async () => Number(await redis.get(VIRTUAL_TIME_KEY)),
    readBase: async () => Number((await redis.get(BASE_KEY)) ?? 0),
    isRebasing: async () => (await redis.exists(REBASE_KEY)) === 1,
    readPrioritizedWithScores: async () =>
      (await redis.zrange(PRIORITIZED_KEY, 0, -1, 'WITHSCORES')).map(
        (value, index) => (index % 2 === 1 ? Number(value) : value),
      ),
  };
};

const createBrokenTagger = () =>
  new FairPriorityTagger({
    getClient: async () => {
      throw new Error('Redis connection lost');
    },
    keyPrefix: KEY_PREFIX,
  });

describe('FairPriorityTagger', () => {
  beforeAll(() => {
    jest.useRealTimers();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  describe('reserve', () => {
    it('tags a reservation at its latest clock and charges each key for its own batch only', async () => {
      const { tagger, readClock } = await createTagger();

      expect(
        await tagger.reserve({
          queueName: QUEUE,
          reservations: [
            { groupKeys: ['workspace:X', 'application:H'], batchSize: 100 },
            { groupKeys: ['workspace:W', 'application:H'], batchSize: 1 },
            { groupKeys: ['workspace:W', 'application:Q'], batchSize: 1 },
          ],
        }),
      ).toEqual({
        base: 0,
        tickets: [
          { tag: 0, weight: 1 },
          { tag: 100, weight: 1 },
          { tag: 1, weight: 1 },
        ],
      });
      expect(await readClock('application:H')).toEqual([0, 101]);
      expect(await readClock('workspace:W')).toEqual([0, 2]);
    });

    it('tags a reservation at the virtual time when it is ahead of its clocks', async () => {
      const { redis, tagger, readClock } = await createTagger();

      await redis.set(VIRTUAL_TIME_KEY, 5);

      expect(
        await tagger.reserve({
          queueName: QUEUE,
          reservations: [{ groupKeys: ['workspace:B'], batchSize: 2 }],
        }),
      ).toEqual({ base: 0, tickets: [{ tag: 5, weight: 1 }] });
      expect(await readClock('workspace:B')).toEqual([0, 7]);
    });

    it('returns the base it reserved on and reads a clock stamped with an older base one step down', async () => {
      const { redis, tagger, readClock } = await createTagger();

      await redis.set(VIRTUAL_TIME_KEY, 3);
      await redis.set(BASE_KEY, STEP);
      await redis.set(
        `${QUEUE_KEY_PREFIX}fair:clock:workspace:S`,
        `0:${STEP + 8}`,
      );

      expect(
        await tagger.reserve({
          queueName: QUEUE,
          reservations: [{ groupKeys: ['workspace:S'], batchSize: 1 }],
        }),
      ).toEqual({ base: STEP, tickets: [{ tag: 8, weight: 1 }] });
      expect(await readClock('workspace:S')).toEqual([STEP, 9]);
    });

    it('reads a clock written before the base existed on the current base', async () => {
      const { redis, tagger, readClock } = await createTagger();

      await redis.set(`${QUEUE_KEY_PREFIX}fair:clock:workspace:L`, 7);

      expect(
        await tagger.reserve({
          queueName: QUEUE,
          reservations: [{ groupKeys: ['workspace:L'], batchSize: 1 }],
        }),
      ).toEqual({ base: 0, tickets: [{ tag: 7, weight: 1 }] });
      expect(await readClock('workspace:L')).toEqual([0, 8]);
    });

    it('weighs a reservation by the product of its key weights and ignores a malformed weight', async () => {
      const { redis, tagger } = await createTagger();

      await redis.hset(WEIGHTS_KEY, 'application:P', '2');
      await redis.hset(WEIGHTS_KEY, 'workspace:W', 'not-a-number');
      await redis.hset(WEIGHTS_KEY, 'application:N', '-1');

      expect(
        await tagger.reserve({
          queueName: QUEUE,
          reservations: [
            { groupKeys: ['workspace:W', 'application:P'], batchSize: 2 },
            { groupKeys: ['workspace:W', 'application:N'], batchSize: 1 },
          ],
        }),
      ).toEqual({
        base: 0,
        tickets: [
          { tag: 0, weight: 2 },
          { tag: 1, weight: 1 },
        ],
      });
    });

    it('returns nothing when Redis is unavailable', async () => {
      expect(
        await createBrokenTagger().reserve({
          queueName: QUEUE,
          reservations: [{ groupKeys: ['workspace:A'], batchSize: 1 }],
        }),
      ).toBeUndefined();
    });
  });

  describe('dispatched', () => {
    // The rebase rewrites BullMQ's prioritized scores in place, so it is pinned to the score layout BullMQ ships
    it('relies on the priority score layout of the installed BullMQ', () => {
      expect(readFileSync(BULLMQ_PRIORITY_SCORE_LUA, 'utf8')).toContain(
        'priority * 0x100000000 + prioCounter % 0x100000000',
      );
    });

    it('advances the virtual time from the dispatched job hash and leaves urgent and missing jobs alone', async () => {
      const { tagger, seedJob, readVirtualTime } = await createTagger();

      await seedJob({
        jobId: 'A1',
        priority: ticketOf(5),
        counter: 1,
        state: 'active',
      });
      await seedJob({
        jobId: 'urgent',
        priority: URGENT_FAIR_PRIORITY,
        counter: 2,
        state: 'active',
      });

      await tagger.dispatched({ queueName: QUEUE, jobId: 'A1' });
      await tagger.dispatched({ queueName: QUEUE, jobId: 'urgent' });
      await tagger.dispatched({ queueName: QUEUE, jobId: 'missing' });

      expect(await readVirtualTime()).toBe(5);
      expect(
        await tagger.reserve({
          queueName: QUEUE,
          reservations: [{ groupKeys: ['workspace:B'], batchSize: 1 }],
        }),
      ).toEqual({ base: 0, tickets: [{ tag: 5, weight: 1 }] });
    });

    it('never moves the virtual time back', async () => {
      const { tagger, seedJob, readVirtualTime } = await createTagger();

      await seedJob({
        jobId: 'late',
        priority: ticketOf(9),
        counter: 1,
        state: 'active',
      });
      await seedJob({
        jobId: 'early',
        priority: ticketOf(3),
        counter: 2,
        state: 'active',
      });

      await tagger.dispatched({ queueName: QUEUE, jobId: 'late' });
      await tagger.dispatched({ queueName: QUEUE, jobId: 'early' });

      expect(await readVirtualTime()).toBe(9);
    });

    it('rewrites the waiting tickets in chunks once the threshold is passed, keeping the order and leaving urgent and static priorities alone', async () => {
      const {
        redis,
        tagger,
        seedJob,
        readPriority,
        readStampedBase,
        readVirtualTime,
        readBase,
        isRebasing,
        readPrioritizedWithScores,
        readClock,
      } = await createTagger();
      const fillerCount = 1200;

      await redis.set(VIRTUAL_TIME_KEY, THRESHOLD - 1);
      await redis.set(
        `${QUEUE_KEY_PREFIX}fair:clock:workspace:A`,
        `0:${THRESHOLD + 3}`,
      );
      await seedJob({
        jobId: 'urgent',
        priority: URGENT_FAIR_PRIORITY,
        counter: 1,
        state: 'prioritized',
      });
      await seedJob({
        jobId: 'static',
        priority: 4,
        counter: 2,
        state: 'prioritized',
      });
      await seedJob({
        jobId: 'A2',
        priority: ticketOf(THRESHOLD + 1),
        counter: 3,
        state: 'prioritized',
      });
      await seedJob({
        jobId: 'A3',
        priority: ticketOf(THRESHOLD + 2),
        counter: 4,
        state: 'prioritized',
      });
      for (let index = 0; index < fillerCount; index += 1) {
        await seedJob({
          jobId: `F${index}`,
          priority: ticketOf(THRESHOLD + 10 + index),
          counter: 100 + index,
          state: 'prioritized',
        });
      }
      await seedJob({
        jobId: 'retrying',
        priority: ticketOf(THRESHOLD + 5),
        counter: 5,
        state: 'delayed',
      });
      await seedJob({
        jobId: 'running',
        priority: ticketOf(THRESHOLD),
        counter: 6,
        state: 'active',
      });

      await tagger.dispatched({ queueName: QUEUE, jobId: 'running' });
      await tagger.rebase(QUEUE);

      expect(await readVirtualTime()).toBe(THRESHOLD - STEP);
      expect(await readBase()).toBe(STEP);
      expect(await isRebasing()).toBe(false);
      expect((await readPrioritizedWithScores()).slice(0, 8)).toEqual([
        'urgent',
        URGENT_FAIR_PRIORITY * PRIORITY_SCORE_BASE + 1,
        'static',
        4 * PRIORITY_SCORE_BASE + 2,
        'A2',
        ticketOf(THRESHOLD + 1 - STEP) * PRIORITY_SCORE_BASE + 3,
        'A3',
        ticketOf(THRESHOLD + 2 - STEP) * PRIORITY_SCORE_BASE + 4,
      ]);
      expect(await redis.zcard(PRIORITIZED_KEY)).toBe(fillerCount + 4);
      expect(await readPriority(`F${fillerCount - 1}`)).toBe(
        ticketOf(THRESHOLD + 10 + fillerCount - 1 - STEP),
      );
      expect(await readStampedBase('A2')).toBe(STEP);
      expect(await readPriority('static')).toBe(4);
      expect(await readStampedBase('static')).toBeUndefined();
      expect(await readPriority('retrying')).toBe(
        ticketOf(THRESHOLD + 5 - STEP),
      );
      expect(await readPriority('running')).toBe(ticketOf(THRESHOLD - STEP));
      expect(
        await tagger.reserve({
          queueName: QUEUE,
          reservations: [{ groupKeys: ['workspace:A'], batchSize: 1 }],
        }),
      ).toEqual({
        base: STEP,
        tickets: [{ tag: THRESHOLD + 3 - STEP, weight: 1 }],
      });
      expect(await readClock('workspace:A')).toEqual([
        STEP,
        THRESHOLD + 4 - STEP,
      ]);
    });

    it('shifts every ticket of a backlog deeper than a step exactly once', async () => {
      const { redis, tagger, seedJob, readPrioritizedWithScores } =
        await createTagger();

      await redis.set(VIRTUAL_TIME_KEY, THRESHOLD - 1);
      for (const depth of [1, 2, 3]) {
        await seedJob({
          jobId: `deep${depth}`,
          priority: ticketOf(THRESHOLD + STEP + depth),
          counter: depth,
          state: 'prioritized',
        });
      }
      await seedJob({
        jobId: 'running',
        priority: ticketOf(THRESHOLD),
        counter: 9,
        state: 'active',
      });

      await tagger.dispatched({ queueName: QUEUE, jobId: 'running' });
      await tagger.rebase(QUEUE);

      expect(await readPrioritizedWithScores()).toEqual([
        'deep1',
        ticketOf(THRESHOLD + 1) * PRIORITY_SCORE_BASE + 1,
        'deep2',
        ticketOf(THRESHOLD + 2) * PRIORITY_SCORE_BASE + 2,
        'deep3',
        ticketOf(THRESHOLD + 3) * PRIORITY_SCORE_BASE + 3,
      ]);
    });

    it('shifts a delayed retry that sits below the old virtual time and leaves an overdue one alone', async () => {
      const { redis, tagger, seedJob, readPriority, readStampedBase } =
        await createTagger();

      await redis.set(VIRTUAL_TIME_KEY, THRESHOLD - 1);
      await seedJob({
        jobId: 'retrying',
        priority: ticketOf(THRESHOLD - STEP + 100),
        counter: 1,
        state: 'delayed',
      });
      await seedJob({
        jobId: 'overdue',
        priority: ticketOf(100),
        counter: 2,
        state: 'delayed',
      });
      await seedJob({
        jobId: 'running',
        priority: ticketOf(THRESHOLD),
        counter: 3,
        state: 'active',
      });

      await tagger.dispatched({ queueName: QUEUE, jobId: 'running' });
      await tagger.rebase(QUEUE);

      expect(await readPriority('retrying')).toBe(ticketOf(100));
      expect(await readStampedBase('retrying')).toBe(STEP);
      expect(await readPriority('overdue')).toBe(ticketOf(100));
      expect(await readStampedBase('overdue')).toBeUndefined();
    });

    it('leaves a job already on the new scale and a ticket reserved before the base existed alone', async () => {
      const { redis, tagger, seedJob, readPriority, readStampedBase } =
        await createTagger();

      await redis.set(VIRTUAL_TIME_KEY, THRESHOLD - 1);
      await seedJob({
        jobId: 'fresh',
        priority: ticketOf(THRESHOLD - STEP + 5),
        counter: 1,
        state: 'prioritized',
        base: STEP,
      });
      await seedJob({
        jobId: 'stamped',
        priority: ticketOf(THRESHOLD - STEP + 6),
        counter: 2,
        state: 'prioritized',
        stampedBase: STEP,
      });
      await seedJob({
        jobId: 'legacy',
        priority: ticketOf(THRESHOLD + 2),
        counter: 3,
        state: 'prioritized',
        base: 'none',
      });
      await seedJob({
        jobId: 'old',
        priority: ticketOf(THRESHOLD + 3),
        counter: 4,
        state: 'prioritized',
      });
      await seedJob({
        jobId: 'running',
        priority: ticketOf(THRESHOLD),
        counter: 5,
        state: 'active',
      });

      await tagger.dispatched({ queueName: QUEUE, jobId: 'running' });
      await tagger.rebase(QUEUE);

      expect(await readPriority('old')).toBe(ticketOf(THRESHOLD + 3 - STEP));
      expect(await readPriority('fresh')).toBe(ticketOf(THRESHOLD - STEP + 5));
      expect(await readPriority('stamped')).toBe(
        ticketOf(THRESHOLD - STEP + 6),
      );
      expect(await readPriority('legacy')).toBe(ticketOf(THRESHOLD + 2));
      expect(await readStampedBase('legacy')).toBeUndefined();
    });

    it('dispatches a job fetched before the switch without switching the scale again', async () => {
      const {
        redis,
        tagger,
        seedJob,
        readPriority,
        readVirtualTime,
        readBase,
        isRebasing,
      } = await createTagger();

      await redis.set(VIRTUAL_TIME_KEY, THRESHOLD - 1);
      await seedJob({
        jobId: 'j1',
        priority: ticketOf(THRESHOLD),
        counter: 1,
        state: 'active',
      });
      await seedJob({
        jobId: 'j2',
        priority: ticketOf(THRESHOLD + 3),
        counter: 2,
        state: 'active',
      });

      await tagger.dispatched({ queueName: QUEUE, jobId: 'j1' });
      await tagger.rebase(QUEUE);
      await tagger.dispatched({ queueName: QUEUE, jobId: 'j2' });

      expect(await readBase()).toBe(STEP);
      expect(await readVirtualTime()).toBe(THRESHOLD + 3 - STEP);
      expect(await readPriority('j2')).toBe(ticketOf(THRESHOLD + 3 - STEP));
      expect(await isRebasing()).toBe(false);
    });

    it('normalizes a ticket reserved before the switch and inserted after it', async () => {
      const {
        redis,
        tagger,
        seedJob,
        readPriority,
        readStampedBase,
        readPrioritizedWithScores,
        isRebasing,
      } = await createTagger({ rebaseGraceMs: 50 });

      await redis.set(VIRTUAL_TIME_KEY, THRESHOLD - 1);
      await seedJob({
        jobId: 'x',
        priority: ticketOf(THRESHOLD),
        counter: 1,
        state: 'active',
      });

      const reservation = await tagger.reserve({
        queueName: QUEUE,
        reservations: [{ groupKeys: ['workspace:late'], batchSize: 1 }],
      });

      expect(reservation).toEqual({
        base: 0,
        tickets: [{ tag: THRESHOLD - 1, weight: 1 }],
      });

      await tagger.dispatched({ queueName: QUEUE, jobId: 'x' });
      await seedJob({
        jobId: 'late',
        priority: ticketOf(THRESHOLD - 1),
        counter: 9,
        state: 'prioritized',
      });
      await tagger.rebase(QUEUE);

      expect(await readPriority('late')).toBe(ticketOf(THRESHOLD - 1 - STEP));
      expect(await readStampedBase('late')).toBe(STEP);
      expect(await readPrioritizedWithScores()).toEqual([
        'late',
        ticketOf(THRESHOLD - 1 - STEP) * PRIORITY_SCORE_BASE + 9,
      ]);
      expect(await isRebasing()).toBe(false);
    });

    it('shifts a ticket reserved on an older scale at dispatch and stamps the job', async () => {
      const {
        redis,
        tagger,
        seedJob,
        readPriority,
        readStampedBase,
        readVirtualTime,
        readBase,
        isRebasing,
      } = await createTagger();

      await redis.set(VIRTUAL_TIME_KEY, THRESHOLD - STEP);
      await redis.set(BASE_KEY, STEP);
      await seedJob({
        jobId: 'stray',
        priority: ticketOf(THRESHOLD + 5),
        counter: 1,
        state: 'active',
      });

      await tagger.dispatched({ queueName: QUEUE, jobId: 'stray' });

      expect(await readPriority('stray')).toBe(ticketOf(THRESHOLD + 5 - STEP));
      expect(await readStampedBase('stray')).toBe(STEP);
      expect(await readVirtualTime()).toBe(THRESHOLD + 5 - STEP);
      expect(await readBase()).toBe(STEP);
      expect(await isRebasing()).toBe(false);
    });

    it('swallows a Redis failure', async () => {
      await expect(
        createBrokenTagger().dispatched({ queueName: QUEUE, jobId: 'j' }),
      ).resolves.toBeUndefined();
    });
  });
});
