import PACKAGE from "../package.json" with { type: "json" };

export const SERVER_INFO = { name: PACKAGE.name, version: PACKAGE.version };
