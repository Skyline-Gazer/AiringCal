import type { SyncWorkflowParams } from '@airing-cal/storage'

interface ScheduledWorkflowEnv {
  SYNC_WORKFLOW: {
    create(options: { id: string; params: SyncWorkflowParams }): Promise<unknown>
  }
}

export async function triggerScheduledWorkflow(env: ScheduledWorkflowEnv, scheduledTime: number): Promise<void> {
  const scheduledAt = Math.floor(scheduledTime / 1000)
  await env.SYNC_WORKFLOW.create({
    id: `scheduled-${scheduledAt}`,
    params: { mode: 'live', source: 'schedule' },
  })
}
