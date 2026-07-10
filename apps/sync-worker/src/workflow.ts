import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { NonRetryableError } from 'cloudflare:workflows'
import type { SyncWorkflowParams } from '@airing-cal/storage'
import { runSyncWorkflow, type SyncWorkflowEnv, type WorkflowStepLike } from './workflow-core.ts'

export class SyncWorkflow extends WorkflowEntrypoint<SyncWorkflowEnv, SyncWorkflowParams> {
  async run(event: Readonly<WorkflowEvent<SyncWorkflowParams>>, step: WorkflowStep): Promise<unknown> {
    return runSyncWorkflow(this.env, {
      instanceId: event.instanceId,
      payload: event.payload,
      schedule: event.schedule,
    }, step as unknown as WorkflowStepLike, (message) => new NonRetryableError(message))
  }
}
