// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Briefing } from "@spi-code/contracts";

export const FLOW_MODES: Record<Briefing["flow"]["mode"], string> = {
  flight: "Syncs in progress",
  planning: "Planning upstream syncs",
  quiet: "Nothing queued",
};

export function FlowContext({
  flow,
  onSelect,
}: {
  flow: Briefing["flow"];
  onSelect(id: string): void;
}) {
  return (
    <section aria-label="Upstream syncs" data-pointer="/briefing/flow">
      <h3>Upstream syncs</h3>
      <p data-pointer="/briefing/flow/mode">{FLOW_MODES[flow.mode]}</p>
      <p data-pointer="/briefing/flow/headline">{flow.headline}</p>
      {flow.sub && <p data-pointer="/briefing/flow/sub">{flow.sub}</p>}
      <dl className="env-facts">
        {flow.tiles.map((tile, index) =>
          tile.label === "Waiting on you" ? null : (
            <div
              className={`env-fact tone-${tile.tone}`}
              key={tile.label}
              data-pointer={`/briefing/flow/tiles/${index}`}
            >
              <dt className="env-fact-label">{tile.label}</dt>
              <dd>
                <strong>{tile.value}</strong>
                {tile.meter && (
                  <meter
                    aria-label={tile.label}
                    min={0}
                    max={tile.meter.cap}
                    value={tile.meter.busy}
                  />
                )}
                <span>{tile.sub}</span>
              </dd>
            </div>
          ),
        )}
      </dl>
      {(flow.plan.title || flow.plan.lines.length > 0 || flow.plan.note) && (
        <div className="env-flow-plan" data-pointer="/briefing/flow/plan">
          {flow.plan.title && <h3 data-pointer="/briefing/flow/plan/title">{flow.plan.title}</h3>}
          {flow.plan.lines.length > 0 && (
            <dl>
              {flow.plan.lines.map((line, index) => (
                <div key={line.label} data-pointer={`/briefing/flow/plan/lines/${index}`}>
                  <dt>{line.label}</dt>
                  <dd>{line.text}</dd>
                </div>
              ))}
            </dl>
          )}
          {flow.plan.note && <p data-pointer="/briefing/flow/plan/note">{flow.plan.note}</p>}
        </div>
      )}
      {(flow.next.title || flow.next.text || flow.next.button) && (
        <div data-pointer="/briefing/flow/next">
          {flow.next.title && <h3>{flow.next.title}</h3>}
          {flow.next.text && <p>{flow.next.text}</p>}
          {flow.next.button && (
            <button type="button" onClick={() => onSelect(flow.inspect)}>
              View upstream plan
            </button>
          )}
        </div>
      )}
      {flow.also.length > 0 && (
        <ul aria-label="Also waiting">
          {flow.also.map((item, index) => (
            <li key={item.text} data-pointer={`/briefing/flow/also/${index}`}>
              {item.inspect ? (
                <button type="button" onClick={() => item.inspect && onSelect(item.inspect)}>
                  {item.text}
                </button>
              ) : (
                item.text
              )}
            </li>
          ))}
        </ul>
      )}
      {flow.schedule && (
        <div data-pointer="/briefing/flow/schedule">
          <h3>{flow.schedule.title}</h3>
          <p>{flow.schedule.text}</p>
        </div>
      )}
    </section>
  );
}
