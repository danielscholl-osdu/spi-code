// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, it } from "vitest";
import { z } from "zod";
import { MessageSchema } from "./index.js";

it("pins the c3t.10 message shapes with optional picker fields on models.result", () => {
  const kinds = [
    "signin.state",
    "session.ended",
    "host.hello",
    "ping",
    "pong",
    "models.list",
    "models.result",
    "turn.start",
    "turn.delta",
    "turn.end",
    "tool.call",
    "error",
  ];
  const schemas = kinds.map((type) => {
    const schema = MessageSchema.options.find((option) => option.shape.type.value === type);
    if (!schema) throw new Error(`Missing legacy message: ${type}`);
    const json = z.toJSONSchema(schema);
    // Host, window and desktop upgrade together, so the version is not pinned here.
    const version = json.properties?.version;
    if (!version || typeof version !== "object" || !("const" in version)) {
      throw new Error(`Missing version const: ${type}`);
    }
    version.const = "<protocol-version>";
    return JSON.stringify(json);
  });
  expect(schemas).toMatchInlineSnapshot(`
    [
      "{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"version":{"type":"number","const":"<protocol-version>"},"id":{"type":"string","minLength":1},"kind":{"type":"string","const":"event"},"type":{"type":"string","const":"signin.state"},"payload":{"type":"object","properties":{"signedIn":{"type":"boolean"},"mode":{"type":"string","enum":["gh","stub"]}},"required":["signedIn","mode"],"additionalProperties":false}},"required":["version","id","kind","type","payload"],"additionalProperties":false}",
      "{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"version":{"type":"number","const":"<protocol-version>"},"id":{"type":"string","minLength":1},"kind":{"type":"string","const":"event"},"type":{"type":"string","const":"session.ended"},"payload":{"type":"object","properties":{"reason":{"type":"string","enum":["credential_changed","authentication_failed"]}},"required":["reason"],"additionalProperties":false}},"required":["version","id","kind","type","payload"],"additionalProperties":false}",
      "{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"version":{"type":"number","const":"<protocol-version>"},"id":{"type":"string","minLength":1},"kind":{"type":"string","const":"event"},"type":{"type":"string","const":"host.hello"},"payload":{"type":"object","properties":{"pid":{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991}},"required":["pid"],"additionalProperties":false}},"required":["version","id","kind","type","payload"],"additionalProperties":false}",
      "{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"version":{"type":"number","const":"<protocol-version>"},"id":{"type":"string","minLength":1},"kind":{"type":"string","const":"request"},"type":{"type":"string","const":"ping"},"payload":{"type":"object","properties":{},"additionalProperties":false}},"required":["version","id","kind","type","payload"],"additionalProperties":false}",
      "{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"version":{"type":"number","const":"<protocol-version>"},"id":{"type":"string","minLength":1},"kind":{"type":"string","const":"response"},"type":{"type":"string","const":"pong"},"payload":{"type":"object","properties":{},"additionalProperties":false}},"required":["version","id","kind","type","payload"],"additionalProperties":false}",
      "{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"version":{"type":"number","const":"<protocol-version>"},"id":{"type":"string","minLength":1},"kind":{"type":"string","const":"request"},"type":{"type":"string","const":"models.list"},"payload":{"type":"object","properties":{},"additionalProperties":false}},"required":["version","id","kind","type","payload"],"additionalProperties":false}",
      "{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"version":{"type":"number","const":"<protocol-version>"},"id":{"type":"string","minLength":1},"kind":{"type":"string","const":"response"},"type":{"type":"string","const":"models.result"},"payload":{"type":"object","properties":{"models":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string","minLength":1},"name":{"type":"string","minLength":1},"multiplier":{"anyOf":[{"type":"number","minimum":0},{"type":"string","const":"not known"}]},"reasoning":{"type":"object","properties":{"supported":{"anyOf":[{"type":"boolean"},{"type":"string","const":"not known"}]},"levels":{"anyOf":[{"type":"array","items":{"type":"string","minLength":1}},{"type":"string","const":"not known"}]},"defaultLevel":{"anyOf":[{"type":"string","minLength":1},{"type":"string","const":"not known"}]}},"required":["supported","levels","defaultLevel"],"additionalProperties":false},"policy":{"type":"object","properties":{"state":{"type":"string","enum":["enabled","disabled","unconfigured","not known"]},"reason":{"anyOf":[{"type":"string","minLength":1},{"type":"string","const":"not known"}]}},"required":["state","reason"],"additionalProperties":false}},"required":["id","name"],"additionalProperties":false}},"account":{"anyOf":[{"type":"object","properties":{"login":{"type":"string","minLength":1}},"required":["login"],"additionalProperties":false},{"type":"string","const":"not known"}]},"usage":{"anyOf":[{"type":"object","properties":{"used":{"anyOf":[{"type":"number","minimum":0},{"type":"string","const":"not known"}]},"entitlement":{"anyOf":[{"type":"number","minimum":0},{"type":"string","const":"unlimited"},{"type":"string","const":"not known"}]},"resetAt":{"anyOf":[{"type":"string","format":"date-time","pattern":"^(?:(?:\\\\d\\\\d[2468][048]|\\\\d\\\\d[13579][26]|\\\\d\\\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\\\d|30)|(?:02)-(?:0[1-9]|1\\\\d|2[0-8])))T(?:(?:[01]\\\\d|2[0-3]):[0-5]\\\\d:[0-5]\\\\d(?:\\\\.\\\\d+)?(?:Z|([+-](?:[01]\\\\d|2[0-3]):[0-5]\\\\d)))$"},{"type":"string","const":"not known"}]}},"required":["used","entitlement","resetAt"],"additionalProperties":false},{"type":"string","const":"not known"}]}},"required":["models"],"additionalProperties":false}},"required":["version","id","kind","type","payload"],"additionalProperties":false}",
      "{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"version":{"type":"number","const":"<protocol-version>"},"id":{"type":"string","minLength":1},"kind":{"type":"string","const":"request"},"type":{"type":"string","const":"turn.start"},"payload":{"type":"object","properties":{"modelId":{"type":"string","minLength":1},"prompt":{"type":"string","minLength":1}},"required":["modelId","prompt"],"additionalProperties":false}},"required":["version","id","kind","type","payload"],"additionalProperties":false}",
      "{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"version":{"type":"number","const":"<protocol-version>"},"id":{"type":"string","minLength":1},"kind":{"type":"string","const":"event"},"type":{"type":"string","const":"turn.delta"},"payload":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false}},"required":["version","id","kind","type","payload"],"additionalProperties":false}",
      "{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"version":{"type":"number","const":"<protocol-version>"},"id":{"type":"string","minLength":1},"kind":{"type":"string","const":"event"},"type":{"type":"string","const":"turn.end"},"payload":{"type":"object","properties":{"reason":{"type":"string","enum":["completed","cancelled","error"]}},"required":["reason"],"additionalProperties":false}},"required":["version","id","kind","type","payload"],"additionalProperties":false}",
      "{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"version":{"type":"number","const":"<protocol-version>"},"id":{"type":"string","minLength":1},"kind":{"type":"string","const":"event"},"type":{"type":"string","const":"tool.call"},"payload":{"type":"object","properties":{"callId":{"type":"string","minLength":1},"name":{"type":"string","minLength":1},"arguments":{"type":"object","propertyNames":{"type":"string"},"additionalProperties":{"$ref":"#/$defs/__schema0"}},"outcome":{"type":"string","enum":["completed","refused","error"]}},"required":["callId","name","arguments"],"additionalProperties":false}},"required":["version","id","kind","type","payload"],"additionalProperties":false,"$defs":{"__schema0":{"anyOf":[{"type":"string"},{"type":"number"},{"type":"boolean"},{"type":"null"},{"type":"array","items":{"$ref":"#/$defs/__schema0"}},{"type":"object","propertyNames":{"type":"string"},"additionalProperties":{"$ref":"#/$defs/__schema0"}}]}}}",
      "{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"version":{"type":"number","const":"<protocol-version>"},"id":{"type":"string","minLength":1},"kind":{"type":"string","const":"response"},"type":{"type":"string","const":"error"},"payload":{"type":"object","properties":{"code":{"type":"string","minLength":1},"message":{"type":"string","minLength":1}},"required":["code","message"],"additionalProperties":false}},"required":["version","id","kind","type","payload"],"additionalProperties":false}",
    ]
  `);
});
