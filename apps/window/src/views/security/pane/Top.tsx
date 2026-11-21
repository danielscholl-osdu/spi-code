// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SecurityBlock, SecurityLane, SecurityPage } from "@spi-code/contracts";
import { type CSSProperties, type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { navigate, routeHash } from "../../../app/navigation.js";
import type { SectionProps } from "./state.js";
import { Words, wordsText } from "./Words.js";
import "./Top.css";

/** The room every bar leaves for the not-read stub and the gap before it, so the bars keep one scale. */
const STUB_ROOM = 40;

const EVIDENCE = { kind: "evidence", from: { kind: "security" } } as const;

/** The line above the headline, the headline and the not-read banner. */
export function Lead({ page }: { page: SecurityPage }) {
  return (
    <>
      <p className="security-headline">
        <span className="security-totals">
          <Words words={page.totals} />
        </span>
        <Words words={page.headline} />
      </p>
      {page.banner.length > 0 && (
        <p className="security-banner">
          <span>
            <Words words={page.banner} />
          </span>{" "}
          <a
            href={routeHash(EVIDENCE)}
            onClick={(event) => {
              event.preventDefault();
              navigate(EVIDENCE);
            }}
          >
            Evidence ›
          </a>
        </p>
      )}
    </>
  );
}

/** The lead, then the three bars. */
export function Top({ pane, lane, state, actions }: SectionProps) {
  const { page } = pane;
  const figure = useRef<HTMLDivElement>(null);
  useFitLabels(figure);
  const stubbed = page.stub.length > 0;
  return (
    <div className="security-top">
      <Lead page={page} />
      <div ref={figure} className="security-figure">
        {pane.lanes.map((row) => (
          <div key={row.id} className="security-fig-row" data-lane={row.id}>
            <button
              type="button"
              className="security-fig-name"
              aria-pressed={row.id === lane.id}
              onClick={() => actions.chooseLane(row.id)}
            >
              <span className="security-fig-label">
                <span className="security-fig-swatch" aria-hidden="true" />
                {row.figure.label}
              </span>
              <span className="security-fig-who">{row.figure.who}</span>
            </button>
            <div className="security-fig-track">
              {row.figure.blocks.length > 0 ? (
                <fieldset
                  className="security-fig-bar"
                  aria-label={row.figure.label}
                  style={{
                    width: `calc((100% - ${stubbed ? STUB_ROOM : 0}px) * ${page.barMax ? row.total.n / page.barMax : 0})`,
                  }}
                >
                  {row.figure.blocks.map((block) => (
                    <Block
                      key={block.rules[0]}
                      block={block}
                      lane={row}
                      selected={block.rules.length === 1 && state.rule === block.rules[0]}
                      onChoose={() =>
                        block.rules.length === 1 && block.rules[0]
                          ? actions.openRule(block.rules[0])
                          : actions.chooseLane(row.id)
                      }
                    />
                  ))}
                </fieldset>
              ) : (
                <span className="security-fig-nothing">
                  <Words words={row.figure.empty} />
                </span>
              )}
              {stubbed && (
                <span
                  className="security-fig-stub"
                  role="img"
                  title={wordsText(page.stub)}
                  aria-label={wordsText(page.stub)}
                />
              )}
            </div>
            <div className="security-fig-total">
              <b>
                <Words words={[row.total]} />
              </b>
              <span>
                <Words words={row.figure.high} />
              </span>
            </div>
          </div>
        ))}
        <div className="security-fig-legend">
          <span>
            <i data-key="high" />
            {page.legend.high}
          </span>
          <span>
            <i data-key="rest" />
            {page.legend.rest}
          </span>
          {page.legend.unread && (
            <span>
              <i data-key="unread" />
              {page.legend.unread}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function Block({
  block,
  lane,
  selected,
  onChoose,
}: {
  block: SecurityBlock;
  lane: SecurityLane;
  selected: boolean;
  onChoose: () => void;
}) {
  const share = block.alerts.n ? (block.high / block.alerts.n) * 100 : 0;
  const name = wordsText(block.name);
  const style = {
    flexGrow: block.alerts.n,
    "--high": `${share}%`,
    ...(block.dividers.length ? { "--cuts": cuts(block.dividers) } : {}),
  } as CSSProperties;
  return (
    <button
      type="button"
      className="security-fig-block"
      data-lane={lane.id}
      data-grouped={block.rules.length > 1 || undefined}
      data-mixed={(block.high > 0 && block.high < block.alerts.n) || undefined}
      data-share={share}
      data-selected={selected || undefined}
      style={style}
      title={name}
      aria-label={name}
      onClick={onChoose}
    >
      <span className="security-fig-count">
        <Words words={[block.alerts]} />
      </span>
    </button>
  );
}

const cuts = (dividers: readonly number[]) =>
  `linear-gradient(90deg,${dividers
    .map((at) => {
      const x = `${at * 100}%`;
      return `transparent calc(${x} - .75px),var(--surface) calc(${x} - .75px) calc(${x} + .75px),transparent calc(${x} + .75px)`;
    })
    .join(",")})`;

function fitLabels(root: HTMLElement) {
  for (const block of root.querySelectorAll<HTMLElement>(".security-fig-block")) {
    const label = block.firstElementChild as HTMLElement | null;
    if (!label) continue;
    const share = Number(block.dataset.share ?? 0) / 100;
    const room = block.hasAttribute("data-mixed")
      ? block.clientWidth * (1 - share) - 3
      : block.clientWidth - 6;
    label.toggleAttribute("data-hidden", label.offsetWidth > room);
  }
}

/** A block's count shows only where it fits; on a part-solid block it must fit in the outlined part. */
function useFitLabels(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    if (ref.current) fitLabels(ref.current);
  });
  useEffect(() => {
    const root = ref.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => fitLabels(root));
    observer.observe(root);
    return () => observer.disconnect();
  }, [ref]);
}
