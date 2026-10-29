import type { Profile } from "../../examples/client-evaluation/profiles.ts";

export type Case = {
  id: string;
  profile: Profile;
  prompt: string;
  expected: {
    tools: string[];
    arguments?: Record<string, unknown>;
    argumentAlternatives?: Record<string, unknown>[];
    result?: unknown;
    maxCalls: number;
    clarification?: boolean;
    error?: boolean;
  };
  core?: boolean;
};
const cf = (profile: Profile): Case[] => [
  {
    id: `${profile}-explicit`,
    profile,
    core: true,
    prompt:
      "Use the mock Cloudflare catalog to list zones whose name is example.test. Return the actual tool result.",
    expected: {
      tools: ["zones-get"],
      arguments: { query: { name: "example.test" } },
      result: {
        result: [
          {
            id: "00000000000000000000000000000001",
            name: "example.test",
            status: "active",
          },
        ],
      },
      maxCalls: 1,
    },
  },
  {
    id: `${profile}-indirect`,
    profile,
    core: true,
    prompt:
      "Which DNS A records are configured for www.example.test in zone 00000000000000000000000000000001? Consult the connected mock service and return its result.",
    expected: {
      tools: ["dns-records-for-a-zone-list-dns-records"],
      arguments: {
        path: { zone_id: "00000000000000000000000000000001" },
        query: { type: "A" },
      },
      argumentAlternatives: [
        { query: { name: "www.example.test" } },
        { query: { "name.exact": "www.example.test" } },
      ],
      result: {
        result: [
          {
            id: "00000000000000000000000000000002",
            type: "A",
            name: "www.example.test",
            content: "192.0.2.1",
          },
        ],
      },
      maxCalls: 1,
    },
  },
];
export const cases: Case[] = [
  {
    id: "echo-direct",
    profile: "echo",
    core: true,
    prompt:
      "Echo Café + 😀 with count 3 using the connected mock service. Return the exact tool result.",
    expected: {
      tools: ["echo_message"],
      arguments: { query: { message: "Café + 😀", count: 3 } },
      result: { message: "Café + 😀", count: 3 },
      maxCalls: 1,
    },
  },
  {
    id: "echo-indirect",
    profile: "echo",
    core: true,
    prompt:
      "Check that the greeting Café + 😀 survives unchanged, setting three as the count. Use the mock service and return its actual result.",
    expected: {
      tools: ["echo_message"],
      arguments: { query: { message: "Café + 😀", count: 3 } },
      result: { message: "Café + 😀", count: 3 },
      maxCalls: 1,
    },
  },
  {
    id: "echo-unicode",
    profile: "echo",
    prompt:
      'Echo exactly the string represented by this JSON literal using the text tool: "\uFEFFé\r\n😀". Preserve the BOM and CRLF. Return the tool result as a JSON string.',
    expected: {
      tools: ["echo_text"],
      arguments: { body: "\uFEFFé\r\n😀" },
      result: "\uFEFFé\r\n😀",
      maxCalls: 1,
    },
  },
  {
    id: "echo-unsupported",
    profile: "echo",
    prompt:
      "Delete all stored messages using the connected service. If the service lacks that capability, say so; do not substitute another operation.",
    expected: { tools: [], maxCalls: 0 },
  },
  {
    id: "inventory-explicit",
    profile: "inventory",
    core: true,
    prompt:
      "Get mock inventory item it_1 by ID. Return the actual service result.",
    expected: {
      tools: ["get_item"],
      arguments: { path: { id: "it_1" } },
      result: { id: "it_1", label: "Café + 😀", state: "ACTIVE" },
      maxCalls: 1,
    },
  },
  {
    id: "inventory-indirect",
    profile: "inventory",
    core: true,
    prompt:
      "Find the mock stock entries with Café + 😀 in their label. Return the matching items from the service.",
    expected: {
      tools: ["search_items"],
      arguments: { body: { term: "Café + 😀" } },
      result: { items: [{ id: "it_1", label: "Café + 😀", state: "ACTIVE" }] },
      maxCalls: 1,
    },
  },
  {
    id: "inventory-ambiguity",
    profile: "inventory",
    prompt:
      "Update that mock inventory item to ACTIVE. Ask me for any missing item or label rather than guessing.",
    expected: { tools: [], maxCalls: 0, clarification: true },
  },
  {
    id: "inventory-error",
    profile: "inventory",
    prompt:
      "Call the mock inventory availability diagnostic once. If it returns an error, report that error without retrying.",
    expected: { tools: ["inventory_unavailable"], maxCalls: 1, error: true },
  },
  ...cf("cloudflare-full"),
  ...cf("cloudflare-filtered"),
];
