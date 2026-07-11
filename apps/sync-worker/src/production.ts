import worker from './index.ts'
import { triggerScheduledWorkflow } from './scheduled-trigger.ts'

export default {
  fetch: worker.fetch,
  scheduled(controller: { scheduledTime: number }, env: Cloudflare.Env): Promise<void> {
    return triggerScheduledWorkflow(env, controller.scheduledTime)
  },
}
export { SyncWorkflow } from './workflow.ts'
