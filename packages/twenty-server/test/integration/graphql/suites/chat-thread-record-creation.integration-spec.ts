import { createChatParticipationTestContext } from 'test/integration/ai/utils/create-chat-participation-test-context.util';
import { createManyOperationFactory } from 'test/integration/graphql/utils/create-many-operation-factory.util';
import { createOneOperationFactory } from 'test/integration/graphql/utils/create-one-operation-factory.util';
import { makeGraphqlApiRequest } from 'test/integration/graphql/utils/make-graphql-api-request.util';

import { WORKSPACE_MEMBER_DATA_SEED_IDS } from 'src/engine/workspace-manager/dev-seeder/data/constants/workspace-member-data-seeds.constant';

describe('Record API chat creation initializes personal inbox state', () => {
  let context: Awaited<ReturnType<typeof createChatParticipationTestContext>>;

  beforeEach(async () => {
    context = await createChatParticipationTestContext();
  });

  afterEach(async () => {
    await context.cleanup();
  });

  const expectCreatorInboxState = async (threadId: string) => {
    const thread = await context.readThread(threadId);
    const participants = await context.readParticipants(threadId);

    expect(thread.workspaceMemberId).toBe(context.workspaceMemberId);
    expect(thread.lastActivityAt).toEqual(expect.any(Date));
    expect(participants).toEqual([
      expect.objectContaining({
        workspaceMemberId: context.workspaceMemberId,
        lastReadAt: thread.lastActivityAt,
        archivedAt: null,
        isSubscribed: true,
      }),
    ]);
  };

  it('creates a read personal inbox copy with the same activity boundary', async () => {
    const threadId = context.registerThread();
    const response = await makeGraphqlApiRequest(
      createOneOperationFactory({
        objectMetadataSingularName: 'agentChatThread',
        gqlFields: 'id',
        data: { id: threadId, title: 'Created through the record API' },
      }),
    );

    expect(response.body.errors).toBeUndefined();
    await expectCreatorInboxState(threadId);
  });

  it('initializes each conversation returned by createMany', async () => {
    const threadIds = [context.registerThread(), context.registerThread()];
    const response = await makeGraphqlApiRequest(
      createManyOperationFactory({
        objectMetadataSingularName: 'agentChatThread',
        objectMetadataPluralName: 'agentChatThreads',
        gqlFields: 'id',
        data: threadIds.map((id) => ({ id, title: 'Created in a batch' })),
      }),
    );

    expect(response.body.errors).toBeUndefined();

    for (const threadId of threadIds) {
      await expectCreatorInboxState(threadId);
    }
  });

  it('preserves an existing owner when creator initialization is repeated by another member', async () => {
    const threadId = await context.createThread();
    const participantsBefore = await context.readParticipants(threadId);
    const authContext = await context.sharingService.getAuthContext({
      workspaceId: context.workspaceId,
      workspaceMemberId: WORKSPACE_MEMBER_DATA_SEED_IDS.JONY,
    });

    await context.threadService.assignCreatedThreadsToCreator({
      authContext,
      threadIds: [threadId],
    });

    expect((await context.readThread(threadId)).workspaceMemberId).toBe(
      context.workspaceMemberId,
    );
    expect(await context.readParticipants(threadId)).toEqual(
      participantsBefore,
    );
  });

  it('initializes the same creator inbox state through createChatThread', async () => {
    await expectCreatorInboxState(await context.createThread());
  });
});
