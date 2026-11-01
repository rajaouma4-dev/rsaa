import * as libsignal from '@privacyresearch/libsignal-protocol-typescript';

console.log('Testing libsignal exports:');
console.log('KeyHelper:', typeof libsignal.KeyHelper);
console.log('SessionBuilder:', typeof libsignal.SessionBuilder);
console.log('SessionCipher:', typeof libsignal.SessionCipher);
console.log('SignalProtocolAddress:', typeof libsignal.SignalProtocolAddress);

async function testCrypto() {
  try {
    const registrationId = libsignal.KeyHelper.generateRegistrationId();
    console.log('Generated registrationId:', registrationId);
    const identityKeyPair = await libsignal.KeyHelper.generateIdentityKeyPair();
    console.log('Generated identityKeyPair pubKey len:', identityKeyPair.pubKey.byteLength);
    const preKey = await libsignal.KeyHelper.generatePreKey(1);
    console.log('Generated preKey id:', preKey.keyId);
    const signedPreKey = await libsignal.KeyHelper.generateSignedPreKey(identityKeyPair, 1);
    console.log('Generated signedPreKey id:', signedPreKey.keyId);
    console.log('Signal Protocol core crypto test PASSED!');
  } catch (err) {
    console.error('Signal Protocol test error:', err);
  }
}

testCrypto();
