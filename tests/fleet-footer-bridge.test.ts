import { describe, expect, it, vi } from "vite-plus/test";
import type { EventBus } from "../extensions/subagents/cross-extension-rpc.js";
import {
  FLEET_CONSUMER_READY_CHANNEL,
  FLEET_PROVIDER_CHANNEL,
  type FleetProviderPayload,
  wireFleetFooterProvider,
} from "../extensions/subagents/fleet-footer-bridge.js";
import type { FleetConsumer, FleetList } from "../extensions/subagents/ui/fleet-list.js";

/** Simple in-process event bus, matching the real `pi.events` semantics. */
function createEventBus(): EventBus {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  return {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
      return () => {
        listeners.get(event)?.delete(handler);
      };
    },
    emit(event, data) {
      for (const handler of listeners.get(event) ?? []) handler(data);
    },
  };
}

/** Fake FleetList exposing only what the bridge touches. */
function fakeFleet() {
  return {
    renderForConsumer: vi.fn(() => ["line1"]),
    attachConsumer: vi.fn((consumer: FleetConsumer) => () => {
      void consumer;
    }),
  } as unknown as FleetList;
}

/** Capture every payload emitted on the provider channel. */
function captureProviderPayloads(events: EventBus): FleetProviderPayload[] {
  const payloads: FleetProviderPayload[] = [];
  events.on(FLEET_PROVIDER_CHANNEL, (data) => payloads.push(data as FleetProviderPayload));
  return payloads;
}

describe("wireFleetFooterProvider", () => {
  it("emits a provider payload immediately on wiring (provider-emits-first ordering)", () => {
    const events = createEventBus();
    const payloads = captureProviderPayloads(events);
    const fleet = fakeFleet();

    wireFleetFooterProvider(events, fleet);

    expect(payloads).toHaveLength(1);
    expect(payloads[0].schema).toBe("subagents.fleet.provider.v1");

    const consumer: FleetConsumer = { requestRender: vi.fn() };
    payloads[0].attach(consumer);
    expect(fleet.attachConsumer).toHaveBeenCalledWith(consumer);
  });

  it("re-emits on consumer-ready even when it arrives after wiring (consumer-ready-first ordering)", () => {
    // "Consumer-ready-first" from jpi-status's perspective: its session_start ran
    // before this side wired the bridge, so its first emit had no listener yet —
    // but wiring always emits once regardless, so the handshake still completes.
    const events = createEventBus();
    // Simulate the lost early emit: nothing is listening on the ready channel yet.
    events.emit(FLEET_CONSUMER_READY_CHANNEL, { schema: "subagents.fleet.consumer-ready.v1" });

    const payloads = captureProviderPayloads(events);
    const fleet = fakeFleet();
    wireFleetFooterProvider(events, fleet);

    expect(payloads).toHaveLength(1);
    const consumer: FleetConsumer = { requestRender: vi.fn() };
    payloads[0].attach(consumer);
    expect(fleet.attachConsumer).toHaveBeenCalledWith(consumer);
  });

  it("re-emits the provider on a later consumer-ready, for a second attach", () => {
    const events = createEventBus();
    const payloads = captureProviderPayloads(events);
    const fleet = fakeFleet();
    wireFleetFooterProvider(events, fleet);
    expect(payloads).toHaveLength(1);

    events.emit(FLEET_CONSUMER_READY_CHANNEL, { schema: "subagents.fleet.consumer-ready.v1" });
    expect(payloads).toHaveLength(2);

    const consumer: FleetConsumer = { requestRender: vi.fn() };
    payloads[1].attach(consumer);
    expect(fleet.attachConsumer).toHaveBeenCalledWith(consumer);
    expect(fleet.attachConsumer).toHaveBeenCalledTimes(1);
  });

  it("delegates render(width, theme) to FleetList.renderForConsumer", () => {
    const events = createEventBus();
    const payloads = captureProviderPayloads(events);
    const fleet = fakeFleet();
    wireFleetFooterProvider(events, fleet);

    const theme = { fg: (_c: string, s: string) => s } as any;
    const lines = payloads[0].render(80, theme);

    expect(fleet.renderForConsumer).toHaveBeenCalledWith(80, theme);
    expect(lines).toEqual(["line1"]);
  });

  it("detach calls back through to FleetList's returned detach", () => {
    const events = createEventBus();
    const payloads = captureProviderPayloads(events);
    const detach = vi.fn();
    const fleet = {
      renderForConsumer: vi.fn(() => []),
      attachConsumer: vi.fn(() => detach),
    } as unknown as FleetList;
    wireFleetFooterProvider(events, fleet);

    const consumer: FleetConsumer = { requestRender: vi.fn() };
    const returnedDetach = payloads[0].attach(consumer);
    returnedDetach();

    expect(detach).toHaveBeenCalledTimes(1);
  });

  it("stops re-emitting once unsubscribed", () => {
    const events = createEventBus();
    const payloads = captureProviderPayloads(events);
    const fleet = fakeFleet();
    const unsub = wireFleetFooterProvider(events, fleet);
    expect(payloads).toHaveLength(1);

    unsub();
    events.emit(FLEET_CONSUMER_READY_CHANNEL, { schema: "subagents.fleet.consumer-ready.v1" });
    expect(payloads).toHaveLength(1);
  });
});
