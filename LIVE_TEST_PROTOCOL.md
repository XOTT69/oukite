# Live verification protocol

Run this checklist only when the P2001E Plus is powered on, connected to Wi‑Fi,
and marked online in Wonderfree. It deliberately performs **no** AC/USB/DC
write command from OUKITEL Home.

1. Open Wonderfree and confirm that the station is online.
2. Open OUKITEL Home, use **Оновити**, and verify the green
   **Підключено · онлайн** status.
3. Compare SOC, input, output and temperature with Wonderfree. Record any
   difference above 1% SOC or 10 W.
4. In Wonderfree, change USB only. Return to OUKITEL Home and wait for the
   next sync. Confirm the USB state and activity history update.
5. Turn the station offline in Wonderfree or disconnect its Wi‑Fi. Confirm
   **Станція офлайн**, retained last values, and an availability event.
6. Restore Wi‑Fi, manually refresh OUKITEL Home, and confirm the green
   online state returns.

Pass criteria: all read-only fields agree with Wonderfree within the limits
above, output-state transitions appear in the history, and no control command
is issued by this PWA.
