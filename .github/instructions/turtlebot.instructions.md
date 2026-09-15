---
applyTo: "packages/turtlebot/**"
---

# `@openlogo/turtlebot` working rules

Scoped rules for files under `packages/turtlebot/`. Read the always-on
[team agreement](openlogo-team.instructions.md) and
[architecture](../../docs/architecture.md) first.

**Owner:** [`@turtle-engine`](../agents/turtle-engine.agent.md)

## Responsibility

Translate the public OpenLogo trace/event stream into bounded physical-turtle commands, publish
programs through an injected MQTT transport, and provide matching mBot2 CyberPi firmware.

## Boundaries

- Consume only public `@openlogo/core` event types; never read runtime or turtle internals.
- Reject trace effects the robot cannot faithfully reproduce. Virtual homing is a terminal stop
  until calibrated odometry exists.
- Keep MQTT credentials and connections outside the TypeScript adapter.
- Require explicit local arming before movement. Stop must remain cooperative during long commands.
- Validate an entire program before queueing it, prevent queue overwrite and replay, and clear stale
  work and arming state after reconnect.

## Validation

- Host translation and MQTT client behavior are covered by `src/index.test.mjs`.
- Firmware safety contracts must remain testable without hardware in
  `firmware/test_openlogo_turtle.py`.