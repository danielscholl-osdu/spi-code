// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { HorizonCard, ViewSnapshot } from "@spi-code/contracts";
import { useId, useState } from "react";
import { navigate } from "../../app/navigation.js";
import { INBOUND_GLYPH, ServiceChip } from "../../components/kit/Chip.js";
import { Mark } from "../../components/kit/Mark.js";
import { SegmentedBar } from "../../components/kit/SegmentedBar.js";
import { Slot, type SlotState } from "../../components/kit/Slot.js";
import { areaEnvelope } from "../../store/evidence.js";
import type { createWatchStore } from "../../store/watch.js";
import { Time } from "../../time.js";
import "./horizon.css";

const ROOT = "/briefing/horizon";
const GLYPHS = { toolchain: "⇡", halt: "⏸", sync: "↻", port: "⇢", rollout: "↗", deadline: "◷" };
const STAGES: Record<HorizonCard["services"][number]["stage"], SlotState> = {
  upstream: "empty",
  queued: "occupied",
  held: "waiting",
  "wont-land": "broken",
  landed: "done",
  unknown: "unknown",
};
const TIERS = {
  stopped: "interrupt",
  "needs-person": "surface",
  "in-progress": "ambient",
  "nothing-due": "background",
} as const;
type Select = (id: string) => void;
const openService = (id: string) => navigate({ kind: "service", id });

function Fork({
  service,
  text,
  pr,
  select,
}: {
  service: string;
  text: string;
  pr?: HorizonCard["services"][number]["pr"];
  select: Select;
}) {
  const inspect = pr?.inspect;
  return (
    <ServiceChip
      service={service}
      text={text}
      onOpen={() => openService(service)}
      {...(pr
        ? {
            pr: {
              number: pr.number,
              text: `${service} #${pr.number}`,
              ...(inspect ? { onOpen: () => select(inspect) } : {}),
            },
          }
        : {})}
    />
  );
}

function Card({ card, pointer, select }: { card: HorizonCard; pointer: string; select: Select }) {
  const target = card.kind === "sync" ? card.itemIds[0] : `theme:${card.id}`;
  return (
    <article
      className="horizon-card"
      data-pointer={pointer}
      data-kind={card.kind}
      data-mark={card.mark}
      data-needs-you={card.needsYou}
      data-card-id={card.id}
      title={card.text}
    >
      <div className="horizon-card-head">
        <span className="horizon-kind" role="img" title={card.kind} aria-label={card.kind}>
          {GLYPHS[card.kind]}
        </span>
        {card.mark && <Mark tier={TIERS[card.mark]} />}
        {target ? (
          <button type="button" className="horizon-token" onClick={() => select(target)}>
            {card.token}
          </button>
        ) : (
          <span className="horizon-token">{card.token}</span>
        )}
      </div>
      <div className="horizon-forks">
        {card.services.map((fork, index) => (
          <span
            className="horizon-fork"
            key={`${fork.service}:${fork.stage}`}
            data-pointer={`${pointer}/services/${index}`}
            data-stage={fork.stage}
          >
            <Slot state={STAGES[fork.stage]} origin="upstream" text={card.text} />
            <Fork service={fork.service} text={card.text} pr={fork.pr} select={select} />
            {fork.at && <Time at={fork.at} hint={false} />}
            {fork.stage === "held" && !fork.pr && <span className="horizon-stage-label">held</span>}
            {fork.stage === "unknown" && <span className="horizon-stage-label">unknown</span>}
            {fork.stage === "wont-land" && <span className="horizon-stage-label">won't land</span>}
          </span>
        ))}
      </div>
      {card.needsYou && card.verb && target && (
        <button type="button" className="horizon-verb" onClick={() => select(target)}>
          {card.verb} ›
        </button>
      )}
    </article>
  );
}

export function Horizon({
  snapshot,
  store,
  onOpenEvidence,
}: {
  snapshot: ViewSnapshot;
  store: ReturnType<typeof createWatchStore>;
  onOpenEvidence: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const stagesId = useId();
  const horizon = snapshot.briefing.horizon;
  const { stages, cards, counts, owed } = horizon;
  const select = store.getState().select;
  const radarFeedsHorizon = snapshot.provenance.some(
    ({ path, areas }) => (path === ROOT || path.startsWith(`${ROOT}/`)) && areas.includes("radar"),
  );
  const radar = areaEnvelope(snapshot, "radar");
  const cut = radarFeedsHorizon && radar.state !== "unread" && radar.completeness?.kind === "cut";
  return (
    <section
      className="today-horizon"
      id="today-horizon"
      aria-label="On the horizon, from upstream GitLab"
    >
      <header className="horizon-header">
        <h2>
          <button
            type="button"
            className="horizon-heading"
            onClick={() => navigate({ kind: "upstream" })}
          >
            <span className="horizon-inbound" aria-hidden="true">
              {INBOUND_GLYPH}
            </span>{" "}
            On the horizon <span>· from upstream GitLab</span>
          </button>
        </h2>
        {cut && (
          <button
            type="button"
            className="kit-chip kit-chip--warn horizon-caveat"
            title="Upstream radar · read only in part. Changes may be missing."
            aria-label="Upstream radar read only in part. Open Evidence."
            onClick={onOpenEvidence}
          >
            ⌀
          </button>
        )}
      </header>
      {stages && (
        <div className="horizon-conveyor" data-expanded={expanded}>
          <button
            type="button"
            className="horizon-compact"
            aria-expanded={expanded}
            aria-controls={stagesId}
            onClick={() => setExpanded(!expanded)}
          >
            <span title={stages.nextSync.text}>
              {stages.nextSync.count}
              {stages.nextSync.at && (
                <>
                  {" "}
                  at <Time at={stages.nextSync.at} hint={false} />
                </>
              )}
            </span>
            <span aria-hidden="true">→</span>
            <span title={stages.held.text}>{stages.held.count} held</span>
            <span aria-hidden="true">→</span>
            <span title={stages.forks.text}>{stages.forks.text}</span>
            <span aria-hidden="true">{expanded ? "⌃" : "⌄"}</span>
          </button>
          <div className="horizon-stages" id={stagesId}>
            <div
              className="horizon-stage horizon-stage--upstream"
              data-pointer={`${ROOT}/stages/upstream`}
              title={stages.upstream.text}
            >
              <h3>upstream</h3>
              <strong>{stages.upstream.count}</strong>
            </div>
            <div
              className="horizon-stage horizon-stage--nextSync"
              data-pointer={`${ROOT}/stages/nextSync`}
              title={stages.nextSync.text}
            >
              <h3>
                next sync {stages.nextSync.at && <Time at={stages.nextSync.at} hint={false} />}
              </h3>
              <strong>{stages.nextSync.count}</strong>
              <div className="horizon-stage-forks">
                {stages.nextSync.services.map((service, i) => (
                  <span data-pointer={`${ROOT}/stages/nextSync/services/${i}`} key={service}>
                    <Fork service={service} text={stages.nextSync.text} select={select} />
                  </span>
                ))}
              </div>
              {stages.wontLand.length > 0 && (
                <div className="horizon-wont-land">
                  <span>won't land</span>
                  {stages.wontLand.map((fork, i) => (
                    <span
                      className="horizon-fork"
                      key={fork.service}
                      data-pointer={`${ROOT}/stages/wontLand/${i}`}
                      data-reason={fork.reason}
                      title={fork.text}
                    >
                      <Slot state="broken" text={fork.text} />
                      <Fork service={fork.service} text={fork.text} select={select} />
                      <span className="horizon-wont-count">{fork.count}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div
              className="horizon-stage horizon-stage--held"
              data-pointer={`${ROOT}/stages/held`}
              title={stages.held.text}
            >
              <h3>in open sync PRs</h3>
              <strong>{stages.held.count}</strong>
              <div className="horizon-stage-forks">
                {stages.held.services.map((service, i) => {
                  const prIndex = stages.held.prs.findIndex((ref) => ref.service === service);
                  const ref = stages.held.prs[prIndex];
                  return (
                    <span data-pointer={`${ROOT}/stages/held/services/${i}`} key={service}>
                      <span
                        className="horizon-held-pr"
                        data-pointer={ref ? `${ROOT}/stages/held/prs/${prIndex}` : undefined}
                      >
                        <Fork
                          service={service}
                          text={stages.held.text}
                          pr={ref?.pr}
                          select={select}
                        />
                      </span>
                    </span>
                  );
                })}
                {stages.held.prs.map((ref, i) =>
                  stages.held.services.includes(ref.service) ? null : (
                    <span
                      className="horizon-held-pr"
                      data-pointer={`${ROOT}/stages/held/prs/${i}`}
                      key={ref.service}
                    >
                      <Fork
                        service={ref.service}
                        text={stages.held.text}
                        pr={ref.pr}
                        select={select}
                      />
                    </span>
                  ),
                )}
              </div>
            </div>
            <div
              className="horizon-stage horizon-stage--forks"
              data-pointer={`${ROOT}/stages/forks`}
              title={stages.forks.text}
            >
              <h3>your forks</h3>
              <span className="horizon-fork-figure">{stages.forks.text}</span>
              <div className="horizon-stage-forks">
                {stages.forks.services.map((service, i) => (
                  <span data-pointer={`${ROOT}/stages/forks/services/${i}`} key={service}>
                    <Fork service={service} text={stages.forks.text} select={select} />
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
      {counts && (
        <p
          className="horizon-counts"
          data-pointer={`${ROOT}/counts`}
          data-need-you={counts.needYouCards}
          data-to-watch={counts.toWatchCards}
        >
          {counts.text}
        </p>
      )}
      {cards && cards.length > 0 && (
        <div className="horizon-cards">
          {cards.map((card, index) => (
            <Card key={card.id} card={card} pointer={`${ROOT}/cards/${index}`} select={select} />
          ))}
        </div>
      )}
      {owed && owed.count > 0 && (
        <div className="horizon-owed" data-pointer={`${ROOT}/owed`}>
          <SegmentedBar
            tint="upstream"
            figure={owed.text}
            text={owed.text}
            segments={owed.services.map((fork) => ({
              id: fork.service,
              label: fork.service,
              count: fork.count,
            }))}
          />
          {owed.itemIds?.map((id) => (
            <button
              type="button"
              className="horizon-owed-open"
              key={id}
              aria-label={owed.text}
              onClick={() => select(id)}
            >
              Detail ›
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
