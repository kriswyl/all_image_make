export type ProtocolFeature = "tools" | "parallel" | "streaming" | "toolChoice" | "nestedSchema";
export type ProtocolEvidence = { supported: boolean; source: "observed" | "probe"; at: string };
export type ToolProtocol = Partial<Record<ProtocolFeature, ProtocolEvidence>>;
