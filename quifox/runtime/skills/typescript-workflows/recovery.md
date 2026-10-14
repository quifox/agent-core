# Recovery and retry

QuiFox writes the workflow run, actor identities, node inputs/results and event order to a private local checkpoint. The script and input must match. Restart the Host, select the original conversation and use its single Resume action. Completed nodes replay recorded results; interrupted nodes reattach to the original internal Session.

Checkpoints belong to the current outer input. Once a new outer input is durably admitted and starts execution, that Session's older-input checkpoints are retired. A write, sync or close failure interrupts the run and cannot produce a successful result. Recovery ignores only an incomplete final WAL line; complete corrupt records fail explicitly.

Recovery is replay from the script entry, not a snapshot of arbitrary JavaScript heap state. Keep control decisions deterministic and pass all changing inputs through args. Do not use Date.now, Math.random or external mutable values to choose branches. Pure local code between durable operations can execute again.

Internal Agents retain their Core tool checkpoints. An unknown interrupted tool receives an explicit incomplete/unknown receipt before model continuation, instead of being silently retried. This protects against claiming an operation was rolled back; it does not provide exactly-once external effects. Business writes need idempotency keys and reconciliation implemented by their plugin/Host.

templates/parallel-retrieval.ts shows fan-out/join with fresh independent research Agents. templates/safe-retry.ts shows bounded retry for read-only retrieval. Its Agent is restricted to knowledge_retrieve by the Host. Install the optional knowledge Mock example before running these templates. Its synthetic documents validate the integration only, not retrieval quality or real-world knowledge. Never apply the retry pattern to side effects. A caught failed ask is replayed as the same failure; later retry nodes retain their own identities.

Typed asks validate interface results and return corrective feedback to the same actor. Invalid input, authentication failure and missing configuration should be fixed rather than retried blindly. Runtime process loss, storage failure, model outages and business idempotency require separate deployment testing. Local workbench validation is not a production readiness guarantee.
