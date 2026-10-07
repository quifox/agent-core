# Roadmap

Agent Core explores how much agent behavior can be assembled from a small kernel and explicit plugins. The main tradeoff is deliberate: mutable Context and Hook data allow flexible experiments, while cooperating plugins need clear shared contracts.

This roadmap describes desired developer outcomes. Now, Next, and Explore indicate sequence and confidence rather than release dates. Exploratory ideas are candidates, not committed APIs or production-readiness promises.

## Existing foundation

The current packages provide Chat and Responses generation, conversation history, interruption, checkpoints, input steering, compaction, peer Teams, child tasks, Tool catalogs, events, code execution, and next-Agent composition. These capabilities already exist; the following priorities focus on making their behavior easier to understand and assess.

## Now: make the first composition reproducible

Enable developers to build a real conversation from the documented Core and plugin APIs, so they can evaluate the project without inventing missing components.

- Examples should expose all required objects and configuration, with protocol clients remaining inside Model plugins.
- Human guides should explain the kernel, capability ownership, plugin ordering, and the limits of the research project.
- Each package should have a clear purpose and a usable entry point.

**Success evidence:** documented imports resolve; examples exercise actual plugin assembly; fixture validation and live-model evidence are distinguished.

## Next: make supported compositions predictable

Enable plugin authors to combine capabilities with explicit state and lifecycle ownership, so failures can be understood without relying on undocumented fields or accidental order.

- Clarify consumed and published capabilities, object pairing, Hook order, and supported sharing.
- Strengthen composition tests around cleanup, rejected or batched calls, mutable results, and new Agent references.
- Keep unknown Tool effects distinct from completed or unstarted calls when recovering.

**Success evidence:** each recommended combination names its collaborators and ordering requirements, with regression cases for its supported failure and concurrency boundaries.

**Sequence:** establish contracts before adding more convenience APIs. Third-party plugins remain free to choose their own contracts.

## Next: improve confidence across protocols and Hosts

Enable developers to assess the same plugin behavior in different Hosts, so portability claims reflect execution evidence rather than types alone.

- Cover malformed and incomplete protocol streams, cancellation, fragmented UTF-8, and Responses cursor acceptance.
- Verify distribution entry points alongside source-level tests.
- Expand Host-specific examples where they demonstrate a distinct capability or failure boundary.

**Success evidence:** supported protocol and Host combinations have repeatable tests and clearly identified live-I/O checks. Coverage identifies untested branches; it does not stand in for correctness or production guarantees.

## Explore: alternative orchestration through plugins

Investigate whether LLM-only or plan-and-execute patterns can reuse model and Tool capabilities through explicit plugin collaboration, so developers can experiment with agent strategies without accumulating fixed Core policy.

**Candidate evidence:** a small prototype states which operations and Hooks it reuses, preserves ordinary call and cleanup semantics, and identifies where the default step model does not fit. The current afterStep continuation rule remains unchanged.

## Explore: inspect and filter untrusted Tool output

Investigate optional plugins that contribute trusted prompt guidance and inspect Tool results, so Hosts can apply their own content policies without coupling the kernel to a particular detector.

**Candidate evidence:** a realistic untrusted-output example shows the transformed result at the chosen Hook boundary and the required ordering with Session and observers. Keyword rules and semantic detectors are implementation choices; neither implies a general prompt-injection defense guarantee.

## Design boundaries

Progress should preserve explicit plugin objects and order, lifetime Context, per-call Outcome, Tool-owned prepare/execute behavior, and ordinary Agent run/stream entry points. Peer Teams keep member equality and do not impose a global business completion condition.

Automatic dependency sorting, universal compatibility wrappers, built-in admission or retry policy, and product-specific identities are outside the current direction. Model protocol clients stay inside their owning plugin package. Changes to these boundaries require a separate design decision rather than being implied by this roadmap.
