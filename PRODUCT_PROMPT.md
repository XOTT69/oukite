# OUKITEL Home v2 — product prompt

You are designing a calm, premium, mobile-first control companion for one OUKITEL P2001E Plus power station. It is used under real conditions: outages, charging from solar, night-time checks, and quick decisions about what can remain powered.

## Non-negotiables

- Make the most important answer instantly visible: battery percentage, net power flow, time remaining and whether the data is live.
- Explain every number in plain Ukrainian. Never make the user guess whether a value is live, estimated, unavailable, safe or a device setting.
- Treat physical-device control as safety-critical. Do not pretend an unverified cloud command works. Show its current state, explain the limitation and guide a safe future connection path.
- Optimise for a one-handed iPhone experience: large targets, clear hierarchy, no dense admin dashboard, readable in dark rooms.
- Keep secrets server-side. A user should never need to see or enter `productKey`, `deviceKey`, tokens or backend URLs.
- Be useful with zero live connection: demo state, load-planning tools, clear setup and cached recent readings.

## v2 outcomes

1. **Now**: a glanceable home view with a live/stale/offline distinction, energy flow and actionable summaries.
2. **Plan**: duration calculator with common appliances, adjustable reserve and transparent assumptions.
3. **Insights**: private on-device time series for the last 24 hours, peaks, input/output and a readable recent activity feed.
4. **Control**: a truthful, carefully designed control centre; current switch state is visible but unsupported cloud writes are never sent.
5. **Help**: clear onboarding, connection diagnostics, privacy explanation and non-technical troubleshooting.

## Definition of done

The result feels like a finished personal app rather than a prototype, works as a PWA, remains responsive at iPhone width, has no fake live data in cloud mode, and has tests for calculation and telemetry mapping.
