## ADDED Requirements

### Requirement: Workflow MUST budget external and internal subrequests independently
The Workflow MUST use a typed, persisted accounting model for each invocation. It MUST reserve capacity independently for upstream internet fetches and Cloudflare internal service subrequests, including continuation, retry and terminal-error work. The accounting model MUST NOT persist tokens, upstream response bodies or raw error payloads.

#### Scenario: Multi-user collections exceed one external-request budget
- **WHEN** multiple configured users require more than one Free Plan external-fetch budget of collection pages plus calendar work
- **THEN** the Workflow persists completed page outputs and continues in a later invocation before either invocation exceeds its external-request budget

#### Scenario: Internal request budget reaches a continuation boundary
- **WHEN** staging, preparation or refresh planning would consume the invocation's internal-service budget
- **THEN** the Workflow durably records its continuation position and resumes before the budget is exceeded

### Requirement: Workflow continuation MUST be durable and replay-safe
The Workflow MUST reconstruct fetch, preparation and planning progress solely from deterministic step history and persisted staging manifests after a durable continuation. It MUST NOT depend on in-memory arrays, clocks after run initialization, or a mutable latest-pointer key to resume.

#### Scenario: Workflow resumes after a collection-fetch continuation
- **WHEN** a Workflow resumes after one or more durable collection-fetch continuations
- **THEN** it does not refetch or duplicate staging writes for completed pages and fetches each remaining page exactly once for that instance

#### Scenario: Workflow resumes after a planning continuation
- **WHEN** a live Workflow resumes after a planning continuation
- **THEN** candidate order, frozen due-time evaluation, reservation request and media job IDs remain byte-equivalent to an uninterrupted run

### Requirement: Budget exhaustion MUST leave an observable terminal result
Before an invocation can exhaust its request budget, the Workflow MUST reserve a distinct continuation or terminalization boundary. A final retry failure MUST record a classified terminal error without publishing a partial snapshot or leaving the application run state falsely running.

#### Scenario: A bounded staging write retry exhausts
- **WHEN** a staging or run-state write reaches its configured retry limit near a request-budget boundary
- **THEN** a later reserved invocation records the terminal error, preserves the previous formal snapshot and exposes a non-running run status

