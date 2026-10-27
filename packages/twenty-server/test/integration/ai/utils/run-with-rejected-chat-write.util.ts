import { randomUUID } from 'node:crypto';

import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';

const CHAT_WRITE_REJECTION_PREFIX = 'reject_chat_write_';

export const runWithRejectedChatWrite = async <TResult>({
  workspaceId,
  threadId,
  operation,
  work,
}: {
  workspaceId: string;
  threadId: string;
  operation: 'restore' | 'share';
  work: () => Promise<TResult>;
}): Promise<TResult> => {
  const schema = getWorkspaceSchemaName(workspaceId);
  const triggerName = `${CHAT_WRITE_REJECTION_PREFIX}${randomUUID()}`;
  const tableName = operation === 'restore' ? 'agentChatThread' : 'recordShare';
  const triggerOperations =
    operation === 'restore' ? 'UPDATE' : 'INSERT OR UPDATE';
  const condition =
    operation === 'restore'
      ? `NEW.id = '${threadId}' AND OLD."deletedAt" IS NOT NULL AND NEW."deletedAt" IS NULL`
      : `NEW."recordId" = '${threadId}'`;

  await global.testDataSource.query(
    `CREATE FUNCTION "${schema}"."${triggerName}"() RETURNS trigger LANGUAGE plpgsql AS $body$
     BEGIN
       IF ${condition} THEN RAISE EXCEPTION 'Rejected conversation test write'; END IF;
       RETURN NEW;
     END;
     $body$`,
  );

  try {
    await global.testDataSource.query(
      `CREATE TRIGGER "${triggerName}" BEFORE ${triggerOperations} ON "${schema}"."${tableName}"
       FOR EACH ROW EXECUTE FUNCTION "${schema}"."${triggerName}"()`,
    );

    return await work();
  } finally {
    await global.testDataSource.query(
      `DROP TRIGGER IF EXISTS "${triggerName}" ON "${schema}"."${tableName}"`,
    );
    await global.testDataSource.query(
      `DROP FUNCTION "${schema}"."${triggerName}"()`,
    );
  }
};
