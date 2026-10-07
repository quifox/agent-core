# Teams workbench

English | [简体中文](README.zh-CN.md)

A local research demo with four ordinary peer Agents, independent Chat/model/prompt/Steering/Events objects, and one shared TeamsPlugin. Any member can receive user input. Four member SSE sources and a separate mailbox source present execution/delivery facts.

Four members are this workbench's example configuration. TeamsPlugin has no fixed member count.

## Run

Use the workspace Node/pnpm versions. Server environment supplies MODEL_API_KEY, MODEL_BASE_URL, and MODEL_ID. Credentials never enter the browser.

```sh
pnpm install --frozen-lockfile
pnpm build
node examples/teams-web/dist/server.js
```

Open http://127.0.0.1:18731/; TEAMS_PORT overrides the listener. Submit to any member; further messages go through that Agent's ordinary run and its Steering admission. The team remains alive across calls.

The default task uses explicitly simulated reference/cost data. Model text/Tool calls come from the configured model plugins. This demonstrates framework coordination, not live research or genuine survey results. There is no role-regex final-report rule or global completion signal.

## Observations

UI observes Events/Teams notifications without calling team_receive. Delivery/claim timestamps belong to the Host projection; claiming mail is not task completion. Closing SSE does not stop execution, and reconnect can replay cached display events, not recover model execution.

This is a loopback, in-memory demo rather than multi-user deployment/restart recovery. See the [application contract](docs/specs/architecture.md) and [Teams package](../../packages/agent-plugin-teams/README.md).
