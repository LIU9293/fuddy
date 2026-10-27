// Workerd treats every entry-module export as a Worker entrypoint. Keep test
// helpers and numeric constants in index.ts out of the deployed module exports.
export { default } from './index'
