// Secrets from the environment or from `*_FILE` files. The implementation lives in the protocol
// package so the stick reads its join token the same way.
export {
  CREDENTIAL_FILES,
  MAX_SECRET_FILE_BYTES,
  readSecret,
  readSecretFile,
} from '@jumpmaster/protocol';
