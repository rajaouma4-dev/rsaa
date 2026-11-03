import QuickCrypto, {install} from 'react-native-quick-crypto';
import {Buffer} from 'buffer';

// Install before Signal's module loads so it cannot select the JS crypto fallback.
install();
export const signalCrypto = QuickCrypto;
let ready: Promise<void> | undefined;
export function ensureNativeCrypto(): Promise<void> {
  if (!ready) ready = (async () => {
    const subtle = signalCrypto.subtle;
    if (!subtle || typeof signalCrypto.getRandomValues !== 'function') throw new Error('Native crypto unavailable');
    const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));
    const key = await subtle.importKey('raw', bytes('2b7e151628aed2a6abf7158809cf4f3c'), {name: 'AES-CBC'}, false, ['encrypt', 'decrypt']);
    const iv = bytes('000102030405060708090a0b0c0d0e0f');
    const plain = bytes('6bc1bee22e409f96e93d7e117393172a');
    const encrypted = await subtle.encrypt({name: 'AES-CBC', iv}, key, plain);
    if (Buffer.from(new Uint8Array(encrypted).slice(0, 16)).toString('hex') !== '7649abac8119b246cee98e9b12e9197d') throw new Error('Native AES self-test failed');
    const decrypted = await subtle.decrypt({name: 'AES-CBC', iv}, key, encrypted);
    if (Buffer.from(decrypted).toString('hex') !== Buffer.from(plain).toString('hex')) throw new Error('Native AES roundtrip failed');
    const macKey = await subtle.importKey('raw', new Uint8Array(20).fill(0x0b), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
    const mac = await subtle.sign('HMAC', macKey, Uint8Array.from(Buffer.from('Hi There')));
    if (Buffer.from(mac).toString('hex') !== 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7') throw new Error('Native HMAC self-test failed');
    console.info('[Crypto] native AES/HMAC provider self-test passed');
  })();
  return ready;
}
