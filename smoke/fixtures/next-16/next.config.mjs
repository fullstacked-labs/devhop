// The fixture sits inside the devhop repo, so pin the Turbopack root here;
// otherwise Next picks the repo root and mistakes src/proxy.js for its own proxy file.
export default { turbopack: { root: import.meta.dirname }, agentRules: false };
