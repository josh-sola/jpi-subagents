/**
 * fleet-footer-bridge.ts — hands jpi-status a render provider for the fleet
 * list over `pi.events`, so the fleet rows can draw below the status footer
 * instead of the default `belowEditor` widget.
 *
 * Load-order-independent handshake: this side emits the provider on its own
 * `session_start` and again on every consumer-ready, and jpi-status emits
 * consumer-ready on its own `session_start` after subscribing to the provider
 * channel — so whichever extension's `session_start` runs first, the other's
 * emit still reaches a live listener.
 */

import type { EventBus } from "./cross-extension-rpc.js";
import type { Theme } from "./ui/agent-widget.js";
import type { FleetConsumer, FleetList } from "./ui/fleet-list.js";

export const FLEET_PROVIDER_CHANNEL = "subagents:fleet:provider:v1";
export const FLEET_CONSUMER_READY_CHANNEL = "subagents:fleet:consumer-ready:v1";

export interface FleetProviderPayload {
  schema: "subagents.fleet.provider.v1";
  /** Fleet lines for the given width/theme; `[]` when the fleet view is off or empty. */
  render(width: number, theme: Theme): string[];
  /** Attach a render consumer; returns a detach function. */
  attach(consumer: FleetConsumer): () => void;
}

export interface FleetConsumerReadyPayload {
  schema: "subagents.fleet.consumer-ready.v1";
}

/**
 * Emit the fleet render provider on `FLEET_PROVIDER_CHANNEL`, and re-emit it
 * whenever a consumer announces readiness on `FLEET_CONSUMER_READY_CHANNEL`.
 * Returns the unsubscribe for the consumer-ready listener.
 */
export function wireFleetFooterProvider(events: EventBus, fleet: FleetList): () => void {
  const emitProvider = () => {
    const payload: FleetProviderPayload = {
      schema: "subagents.fleet.provider.v1",
      render: (width, theme) => fleet.renderForConsumer(width, theme),
      attach: consumer => fleet.attachConsumer(consumer),
    };
    events.emit(FLEET_PROVIDER_CHANNEL, payload);
  };

  emitProvider();
  return events.on(FLEET_CONSUMER_READY_CHANNEL, emitProvider);
}
