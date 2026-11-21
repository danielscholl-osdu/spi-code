// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useState } from "react";
import { createTitleStore, TitleProvider } from "../../app/title-row.js";
import Environment from "../../views/environment/index.js";
import ServicePage from "../../views/service/index.js";
import Template from "../../views/template/index.js";
import { PROGRAM, type ThreadTab, type ThreadTabProps } from "./tab.js";

/** The scope's place as the centre draws it; its title stays out of the thread's top row. */
function ReadingTab({ summary }: ThreadTabProps) {
  const [titles] = useState(createTitleStore);
  const scope = summary?.thread.scope;
  if (!scope)
    return (
      <p className="panel-empty" data-quiet="not-known">
        ⌀ This thread's scope is not known.
      </p>
    );
  if (scope === PROGRAM)
    return (
      <p className="panel-empty" data-quiet="program">
        ⌀ The program's reading comes with a later build.
      </p>
    );
  return (
    <TitleProvider value={titles}>
      {scope === "template" ? (
        <Template />
      ) : scope === "environment" ? (
        <Environment />
      ) : (
        <ServicePage id={scope} />
      )}
    </TitleProvider>
  );
}

export const READING_TAB: ThreadTab = { id: "reading", label: "Reading", Panel: ReadingTab };
