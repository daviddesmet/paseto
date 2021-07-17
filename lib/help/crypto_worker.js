const { parentPort, Worker, isMainThread } = require('worker_threads')
const crypto = require('crypto')

const [major, minor] = process.version.substr(1).split('.').map((x) => parseInt(x, 10))
const supportsKeyObjectInPostMessage = major > 14 || (major === 14 && minor >= 5) || (major === 12 && minor >= 19)

if (isMainThread) {
  const tasks = new Map()
  const exportArgs = {
    public: [{ format: 'der', type: 'spki' }],
    private: [{ format: 'der', type: 'pkcs8' }]
  }

  let worker
  let taskId = 0

  const spawn = () => {
    worker = new Worker(__filename)
    worker.on('message', function ({ id, value }) {
      const task = tasks.get(id)
      tasks.delete(id)
      if (tasks.size === 0) {
        worker.unref()
      }
      if (value instanceof Uint8Array) {
        value = Buffer.from(value)
      }
      task(value)
    })
  }

  const a = (method, ...args) => new Promise((resolve) => {
    const id = taskId++
    tasks.set(id, resolve)

    if (worker === undefined) {
      spawn()
    }

    if (!supportsKeyObjectInPostMessage) {
      let key

      let keyObject = args[2]

      if (keyObject instanceof crypto.KeyObject) {
        key = {
          key: keyObject.export.apply(keyObject, exportArgs[keyObject.type]),
          ...exportArgs[keyObject.type][0]
        }
      } else if (Buffer.isBuffer(keyObject)) {
        key = keyObject
      } else {
        key = keyObject
        keyObject = key.key
        key.key = keyObject.export.apply(keyObject, exportArgs[keyObject.type])
        Object.assign(key, exportArgs[keyObject.type][0])
      }

      args[2] = key
    }

    worker.ref()
    worker.postMessage({ id, method, args })
  })

  module.exports = {
    sign: a.bind(undefined, 'sign'),
    verify: a.bind(undefined, 'verify'),
    'aes-256-ctr-hmac-sha-384-encrypt': a.bind(undefined, 'aes-256-ctr-hmac-sha-384-encrypt'),
    'aes-256-ctr-hmac-sha-384-decrypt': a.bind(undefined, 'aes-256-ctr-hmac-sha-384-decrypt'),
    'xchacha20-poly1305-encrypt': a.bind(undefined, 'xchacha20-poly1305-encrypt'),
    'xchacha20-poly1305-decrypt': a.bind(undefined, 'xchacha20-poly1305-decrypt')
  }
/* c8 ignore next 114 */
} else {
  const sodium = require('libsodium-wrappers')

  const pae = require('./pae')
  const hkdf = (key, length, salt, info) => {
    const prk = methods.hmac('sha384', key, salt)

    const u = Buffer.from(info)

    let t = Buffer.from('')
    let lb = Buffer.from('')
    let i

    for (let bi = 1; Buffer.byteLength(t) < length; ++i) {
      i = Buffer.from(String.fromCharCode(bi))
      const inp = Buffer.concat([lb, u, i])

      lb = methods.hmac('sha384', inp, prk)
      t = Buffer.concat([t, lb])
    }

    const orm = Buffer.from(t).slice(0, length)
    return orm
  }

  const pack = require('./pack')
  const timingSafeEqual = require('./timing_safe_equal')

  const methods = {
    'aes-256-ctr-hmac-sha-384-encrypt' (m, f, k, nonce) {
      let n = methods.hmac('sha384', m, nonce)
      n = n.slice(0, 32)
      f = Buffer.from(f)

      const salt = n.slice(0, 16)
      const ek = hkdf(k, 32, salt, 'paseto-encryption-key')
      const ak = hkdf(k, 32, salt, 'paseto-auth-key-for-aead')

      const c = methods.encrypt('aes-256-ctr', m, ek, n.slice(16))
      const preAuth = pae('v1.local.', n, c, f)
      const t = methods.hmac('sha384', preAuth, ak)

      return pack('v1.local.', [n, c, t], f)
    },
    'aes-256-ctr-hmac-sha-384-decrypt' (raw, f, k) {
      const n = raw.slice(0, 32)
      const t = raw.slice(-48)
      const c = raw.slice(32, -48)

      const salt = n.slice(0, 16)
      const ek = hkdf(k, 32, salt, 'paseto-encryption-key')
      const ak = hkdf(k, 32, salt, 'paseto-auth-key-for-aead')

      const preAuth = pae('v1.local.', n, c, f)

      const t2 = methods.hmac('sha384', preAuth, ak)
      if (!timingSafeEqual(t, t2)) return false
      const payload = methods.decrypt('aes-256-ctr', c, ek, n.slice(16))
      if (!payload) return false

      return payload
    },
    hmac (alg, payload, key) {
      const hmac = crypto.createHmac(alg, key)
      hmac.update(payload)
      return hmac.digest()
    },
    verify (alg, payload, key, signature) {
      if (!supportsKeyObjectInPostMessage) {
        key.key = Buffer.from(key.key)
      }
      return crypto.verify(alg, payload, key, signature)
    },
    sign (alg, payload, key) {
      if (!supportsKeyObjectInPostMessage) {
        key.key = Buffer.from(key.key)
      }
      return crypto.sign(alg, payload, key)
    },
    encrypt (cipher, cleartext, key, iv) {
      const encryptor = crypto.createCipheriv(cipher, key, iv)
      return Buffer.concat([encryptor.update(cleartext), encryptor.final()])
    },
    decrypt (cipher, ciphertext, key, iv) {
      try {
        const decryptor = crypto.createDecipheriv(cipher, key, iv)
        return Buffer.concat([decryptor.update(ciphertext), decryptor.final()])
      } catch (err) {
        return false
      }
    },
    'xchacha20-poly1305-encrypt' (cleartext, nonce, key, footer) {
      const n = sodium.crypto_generichash(24, cleartext, nonce)
      const preAuth = pae('v2.local.', n, footer)

      return {
        n,
        c: sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(cleartext, preAuth, undefined, n, key)
      }
    },
    'xchacha20-poly1305-decrypt' (ciphertext, nonce, key, preAuth) {
      try {
        return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(undefined, ciphertext, preAuth, nonce, key)
      } catch (err) {
        return false
      }
    }
  }

  sodium.ready.then(() => {
    parentPort.on('message', function ({ id, method, args }) {
      const value = methods[method](...args)
      parentPort.postMessage({ id, value })
    })
  })
}
