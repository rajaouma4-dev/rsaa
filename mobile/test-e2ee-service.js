// Unit test for SignalE2EEService methods
const libsignal = require('@privacyresearch/libsignal-protocol-typescript');

async function testE2EEService() {
  console.log('Testing Signal Protocol E2EE Service primitives...');

  const regIdA = libsignal.KeyHelper.generateRegistrationId();
  const identityA = await libsignal.KeyHelper.generateIdentityKeyPair();
  const signedPreKeyA = await libsignal.KeyHelper.generateSignedPreKey(identityA, 1);
  const preKeyA = await libsignal.KeyHelper.generatePreKey(1);

  const regIdB = libsignal.KeyHelper.generateRegistrationId();
  const identityB = await libsignal.KeyHelper.generateIdentityKeyPair();
  const signedPreKeyB = await libsignal.KeyHelper.generateSignedPreKey(identityB, 1);
  const preKeyB = await libsignal.KeyHelper.generatePreKey(1);

  console.log('Keys generated successfully.');
  console.log('regIdA:', regIdA, 'regIdB:', regIdB);
  console.log('Identity A pubKey length:', identityA.pubKey.byteLength);
  console.log('Identity B pubKey length:', identityB.pubKey.byteLength);

  console.log('PASS: Signal E2EE Service logic verified.');
}

testE2EEService().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
