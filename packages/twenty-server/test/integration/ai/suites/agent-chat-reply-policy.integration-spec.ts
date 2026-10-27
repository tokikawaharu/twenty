import { configureChatParticipationModels } from 'test/integration/ai/utils/configure-chat-participation-models.util';
import { createChatParticipationTestContext } from 'test/integration/ai/utils/create-chat-participation-test-context.util';

import { AgentMessageRole } from 'src/engine/metadata-modules/ai/ai-history/enums/agent-message-role.enum';
import { AgentMessageStatus } from 'src/engine/metadata-modules/ai/ai-history/enums/agent-message-status.enum';
import { AgentTurnStatus } from 'src/engine/metadata-modules/ai/ai-history/enums/agent-turn-status.enum';
import { WORKSPACE_MEMBER_DATA_SEED_IDS } from 'src/engine/workspace-manager/dev-seeder/data/constants/workspace-member-data-seeds.constant';

describe('Assistant reply selection with stored conversation participants', () => {
  let context: Awaited<ReturnType<typeof createChatParticipationTestContext>>;
  let models: ReturnType<typeof configureChatParticipationModels>;

  beforeEach(async () => {
    context = await createChatParticipationTestContext();
    models = configureChatParticipationModels();
  });

  afterEach(async () => {
    await context.cleanup();
    models.restore();
  });

  const shouldReply = async ({
    threadId,
    isAssistantMentioned = false,
  }: {
    threadId: string;
    isAssistantMentioned?: boolean;
  }) =>
    context.replyPolicyService.shouldReply({
      isAiChatInboxEnabled: true,
      shouldAssistantReply: true,
      thread: await context.threadService.getWritableThread({
        threadId,
        workspaceId: context.workspaceId,
        workspaceMemberId: context.workspaceMemberId,
      }),
      workspaceId: context.workspaceId,
      workspaceMemberId: context.workspaceMemberId,
      userWorkspaceId: context.userWorkspaceId,
      additionalWorkspaceMemberIds: [],
      isAssistantMentioned,
      text: 'Can Ada help with the latest task?',
    });
  const createGroup = async (isAssistantParticipant = true) => {
    const threadId = await context.createThread(isAssistantParticipant);

    await context.threadService.addParticipants({
      workspaceId: context.workspaceId,
      workspaceMemberId: context.workspaceMemberId,
      threadId,
      participantWorkspaceMemberIds: [WORKSPACE_MEMBER_DATA_SEED_IDS.JONY],
      isMention: false,
    });

    return threadId;
  };

  it('does not invoke the evaluator while Ada is absent', async () => {
    models.enableEvaluation();
    const threadId = await createGroup(false);

    await expect(shouldReply({ threadId })).resolves.toBe(false);
    expect(models.evaluate).not.toHaveBeenCalled();
  });

  it('always answers a direct chat without evaluating it', async () => {
    models.enableEvaluation();
    const threadId = await context.createThread();

    await expect(shouldReply({ threadId })).resolves.toBe(true);
    expect(models.evaluate).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'uses the group mention default without JEV when mentioned is %s',
    async (isAssistantMentioned) => {
      const threadId = await createGroup();

      await expect(
        shouldReply({ threadId, isAssistantMentioned }),
      ).resolves.toBe(isAssistantMentioned);
      expect(models.evaluate).not.toHaveBeenCalled();
    },
  );

  it.each([
    { probability: 0.49, shouldAnswer: false },
    { probability: 0.5, shouldAnswer: true },
  ])(
    'uses JEV probability $probability for a group message',
    async ({ probability, shouldAnswer }) => {
      models.enableEvaluation();
      models.evaluate.mockResolvedValue({
        answers: { shouldAssistantReply: { type: 'boolean', probability } },
        usage: { inputTokens: 1, outputTokens: 0 },
        warnings: [],
      });
      const threadId = await createGroup();

      await expect(shouldReply({ threadId })).resolves.toBe(shouldAnswer);
      expect(models.evaluate).toHaveBeenCalledTimes(1);
    },
  );

  it('answers an explicit mention even when JEV declines', async () => {
    models.enableEvaluation();
    models.evaluate.mockResolvedValue({
      answers: { shouldAssistantReply: { type: 'boolean', probability: 0 } },
      usage: { inputTokens: 1, outputTokens: 0 },
      warnings: [],
    });
    const threadId = await createGroup(false);

    await expect(
      shouldReply({
        threadId,
        isAssistantMentioned: true,
      }),
    ).resolves.toBe(true);
    expect(models.evaluate).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'preserves the mention default after an evaluation failure when mentioned is %s',
    async (isAssistantMentioned) => {
      models.enableEvaluation();
      models.evaluate.mockRejectedValue(
        new Error('Evaluation transport failed'),
      );
      const threadId = await createGroup();

      await expect(
        shouldReply({ threadId, isAssistantMentioned }),
      ).resolves.toBe(isAssistantMentioned);
    },
  );

  it('rechecks persisted participants when a direct chat becomes a group', async () => {
    const threadId = await context.createThread();

    await expect(shouldReply({ threadId })).resolves.toBe(true);
    await context.threadService.addParticipants({
      workspaceId: context.workspaceId,
      workspaceMemberId: context.workspaceMemberId,
      threadId,
      participantWorkspaceMemberIds: [WORKSPACE_MEMBER_DATA_SEED_IDS.JONY],
      isMention: false,
    });
    await expect(shouldReply({ threadId })).resolves.toBe(false);
  });

  it('passes only the recent sent conversation texts to the external evaluator', async () => {
    models.enableEvaluation();
    const threadId = await createGroup();

    await context.chatService.replaceOpeningTurn({
      workspaceId: context.workspaceId,
      threadId,
      context: 'Private system context',
    });
    const texts = Array.from({ length: 22 }, (_, index) => `Message ${index}`);
    const messageIds: string[] = [];

    for (const text of texts) {
      const message = await context.chatService.addMessage({
        threadId,
        workspaceId: context.workspaceId,
        userWorkspaceId: context.userWorkspaceId,
        turnStatus: AgentTurnStatus.COMPLETED,
        uiMessage: {
          role: AgentMessageRole.USER,
          parts: [
            { type: 'text', text },
            { type: 'text', text: ' \t\n' },
          ],
        },
      });

      messageIds.push(message.id);
    }

    await global.testDataSource.query(
      `UPDATE "${context.schema}"."agentMessage" message
       SET "processedAt" = $2::timestamptz + source.ordinality * interval '1 second',
           "createdAt" = $2::timestamptz + source.ordinality * interval '1 second'
       FROM unnest($1::uuid[]) WITH ORDINALITY AS source(id, ordinality)
       WHERE message.id = source.id`,
      [messageIds, '2026-01-01T00:00:00.000Z'],
    );

    await context.chatService.addMessage({
      threadId,
      workspaceId: context.workspaceId,
      userWorkspaceId: context.userWorkspaceId,
      turnStatus: AgentTurnStatus.FAILED,
      uiMessage: {
        role: AgentMessageRole.USER,
        parts: [{ type: 'text', text: 'Failed turn' }],
      },
    });
    const queuedMessage = await context.chatService.addMessage({
      threadId,
      workspaceId: context.workspaceId,
      userWorkspaceId: context.userWorkspaceId,
      turnStatus: AgentTurnStatus.COMPLETED,
      uiMessage: {
        role: AgentMessageRole.USER,
        parts: [{ type: 'text', text: 'Queued message' }],
      },
    });
    await global.testDataSource.query(
      `UPDATE "${context.schema}"."agentMessage"
       SET status = $2, "processedAt" = NULL WHERE id = $1`,
      [queuedMessage.id, AgentMessageStatus.QUEUED],
    );
    await shouldReply({ threadId });

    expect(models.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        state: {
          conversation: texts
            .slice(-20)
            .map((text) => ({ role: 'user', text })),
          message: {
            text: 'Can Ada help with the latest task?',
            isAssistantMentioned: false,
          },
        },
      }),
    );
  });
});
