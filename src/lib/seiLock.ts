// The label a Sei Cosmos row gets when its account can never move its SEI
// (see lockUnlinkedSei in cosmosMulti.ts). Its own file so pure code (the
// admin coverage report) can recognize those rows without the server-only
// Cosmos module.
export const SEI_LOCKED_NOTE = "locked: Sei Cosmos account with no linked EVM address (SIP-3)";
