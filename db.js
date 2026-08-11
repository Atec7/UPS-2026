// =====================================================================
// db.js — Camada de dados OFFLINE + Sincronização automática
// =====================================================================
// Substitui as chamadas diretas ao Firebase REST por uma camada que:
//   - Le de um espelho local (IndexedDB) quando offline
//   - Atualiza o espelho local quando online
//   - Enfileira escritas offline (outbox) e sincroniza quando houver rede
// =====================================================================
(function() {
  'use strict';

  var DB_NAME = 'ups-offline';
  var DB_VERSION = 1;
  var STORE_MAP = {
    users: 'users',
    rules: 'rules',
    catalog_services: 'catalog',
    services: 'services',
    location_history: 'location'
  };
  var STORES = ['users', 'rules', 'catalog', 'services', 'location', 'meta', 'outbox'];

  var baseUrl = '';
  var dbPromise = null;
  var flushInProgress = false;
  var statusCallback = null;

  // ------------------------------------------------------------------
  // Utilidades
  // ------------------------------------------------------------------
  function isOnline() {
    return typeof navigator !== 'undefined' && navigator.onLine;
  }

  function extend() {
    var out = {};
    for (var i = 0; i < arguments.length; i++) {
      var o = arguments[i];
      if (!o) continue;
      Object.keys(o).forEach(function(k) { out[k] = o[k]; });
    }
    return out;
  }

  function clone(v) {
    return v == null ? v : JSON.parse(JSON.stringify(v));
  }

  function tempId() {
    return 'offline_' + Date.now() + '_' + Math.floor(Math.random() * 1000000);
  }

  function parsePath(path) {
    var parts = (path || '').split('/').filter(Boolean);
    var root = parts.length ? parts[0] : '';
    var store = STORE_MAP[root] || null;
    return { parts: parts, root: root, store: store };
  }

  // ------------------------------------------------------------------
  // IndexedDB
  // ------------------------------------------------------------------
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function(resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function(e) {
        var db = e.target.result;
        for (var i = 0; i < STORES.length; i++) {
          if (!db.objectStoreNames.contains(STORES[i])) {
            db.createObjectStore(STORES[i], {
              keyPath: STORES[i] === 'outbox' ? 'seq' : 'id',
              autoIncrement: STORES[i] === 'outbox'
            });
          }
        }
      };
      req.onsuccess = function() { resolve(req.result); };
      req.onerror = function() { reject(req.error); };
      req.onblocked = function() { reject(new Error('IndexedDB bloqueado')); };
    });
    return dbPromise;
  }

  function idbReq(req) {
    return new Promise(function(resolve, reject) {
      req.onsuccess = function() { resolve(req.result); };
      req.onerror = function() { reject(req.error); };
    });
  }

  function getAll(storeName) {
    return openDb().then(function(db) {
      return idbReq(db.transaction(storeName).objectStore(storeName).getAll());
    });
  }

  function getOne(storeName, key) {
    return openDb().then(function(db) {
      return idbReq(db.transaction(storeName).objectStore(storeName).get(key));
    });
  }

  function putOne(storeName, obj) {
    return openDb().then(function(db) {
      return idbReq(db.transaction(storeName, 'readwrite').objectStore(storeName).put(obj));
    });
  }

  function putMany(storeName, objs) {
    if (!objs || !objs.length) return Promise.resolve();
    return openDb().then(function(db) {
      return new Promise(function(resolve, reject) {
        var t = db.transaction(storeName, 'readwrite');
        var s = t.objectStore(storeName);
        objs.forEach(function(o) { s.put(o); });
        t.oncomplete = resolve;
        t.onerror = function() { reject(t.error); };
        t.onabort = function() { reject(t.error); };
      });
    });
  }

  function delOne(storeName, key) {
    return openDb().then(function(db) {
      return idbReq(db.transaction(storeName, 'readwrite').objectStore(storeName).delete(key));
    });
  }

  function clearAll(storeName) {
    return openDb().then(function(db) {
      return idbReq(db.transaction(storeName, 'readwrite').objectStore(storeName).clear());
    });
  }

  // ------------------------------------------------------------------
  // Rede (Firebase REST)
  // ------------------------------------------------------------------
  function fbUrl(path) {
    return baseUrl + (path ? '/' + path : '') + '.json';
  }

  function netRead(path) {
    return fetch(fbUrl(path)).then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function netPush(path, data) {
    return fetch(fbUrl(path), { method: 'POST', body: JSON.stringify(data) }).then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function(resp) { return resp.name; });
  }

  function netUpdate(path, data) {
    return fetch(fbUrl(path), { method: 'PATCH', body: JSON.stringify(data) }).then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function netRemove(path) {
    return fetch(fbUrl(path), { method: 'DELETE' }).then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  // ------------------------------------------------------------------
  // Leitura local (espelho)
  // ------------------------------------------------------------------
  function localRead(path) {
    var p = parsePath(path);
    if (p.root === '_initialized') {
      return getOne('meta', '_initialized').then(function(m) {
        return m ? m.value : null;
      });
    }
    if (!p.store) {
      return Promise.resolve(null);
    }
    if (p.root === 'location_history' || p.parts.length === 1) {
      return getAll(p.store).then(function(recs) {
        var obj = {};
        recs.forEach(function(r) {
          var c = clone(r);
          delete c.id;
          obj[r.id] = c;
        });
        return obj;
      });
    }
    return getOne(p.store, p.parts[1]).then(function(r) {
      if (!r) return null;
      var c = clone(r);
      delete c.id;
      return c;
    });
  }

  // ------------------------------------------------------------------
  // Espelhamento (network -> local)
  // ------------------------------------------------------------------
  function pendingRecordsForStore(store) {
    return getAllOutbox().then(function(ops) {
      var ids = [];
      ops.forEach(function(op) {
        if (parsePath(op.path).store !== store) return;
        if (op.type === 'push' && op.tempId) ids.push(op.tempId);
        if ((op.type === 'update' || op.type === 'remove') && op.id) ids.push(op.id);
      });
      var seen = {};
      ids = ids.filter(function(i) { return !seen[i] && (seen[i] = 1); });
      return Promise.all(ids.map(function(id) { return getOne(store, id); })).then(function(recs) {
        return recs.filter(Boolean);
      });
    });
  }

  function mirrorCollection(store, netData) {
    var records = [];
    if (netData) {
      Object.keys(netData).forEach(function(k) {
        records.push(extend({ id: k }, netData[k]));
      });
    }
    return clearAll(store).then(function() {
      return putMany(store, records);
    }).then(function() {
      // preserva registros pendentes criados/editados offline
      return pendingRecordsForStore(store).then(function(pending) {
        if (pending.length) return putMany(store, pending);
      });
    });
  }

  function mirror(path, netData) {
    var p = parsePath(path);
    if (p.root === '_initialized') {
      return putOne('meta', { id: '_initialized', value: netData });
    }
    if (!p.store) return Promise.resolve();
    if (p.root === 'location_history' || p.parts.length === 1) {
      return mirrorCollection(p.store, netData);
    }
    if (netData) {
      return putOne(p.store, extend({ id: p.parts[1] }, netData));
    }
    // item não existe no servidor: preserva se for um registro local pendente (offline)
    return getOne(p.store, p.parts[1]).then(function(existing) {
      if (existing && String(p.parts[1]).indexOf('offline_') === 0) return null;
      return delOne(p.store, p.parts[1]);
    });
  }

  function mergeLocal(store, id, data) {
    return getOne(store, id).then(function(existing) {
      return putOne(store, extend({ id: id }, existing || {}, data));
    });
  }

  function renameLocal(store, oldId, newId) {
    return getOne(store, oldId).then(function(rec) {
      if (!rec) return null;
      var r = clone(rec);
      r.id = newId;
      return delOne(store, oldId).then(function() {
        return putOne(store, r);
      });
    });
  }

  // ------------------------------------------------------------------
  // Outbox (fila de operações offline)
  // ------------------------------------------------------------------
  function enqueue(op) {
    op.created_at = Date.now();
    return openDb().then(function(db) {
      return idbReq(db.transaction('outbox', 'readwrite').objectStore('outbox').add(op));
    }).then(function() {
      notifyStatus();
      return op;
    });
  }

  function getAllOutbox() {
    return getAll('outbox').then(function(ops) {
      return (ops || []).sort(function(a, b) { return a.seq - b.seq; });
    });
  }

  function removeOutbox(seq) {
    return delOne('outbox', seq);
  }

  function remapPath(path, idMap) {
    var parts = (path || '').split('/');
    for (var i = 1; i < parts.length; i++) {
      if (idMap[parts[i]]) {
        parts[i] = idMap[parts[i]];
        break;
      }
    }
    return parts.join('/');
  }

  function execOp(op, idMap) {
    if (op.type === 'push') {
      return netPush(op.path, op.data).then(function(realKey) {
        if (op.tempId) {
          idMap[op.tempId] = realKey;
          var p = parsePath(op.path);
          if (p.store) return renameLocal(p.store, op.tempId, realKey);
        }
      });
    }
    var path = remapPath(op.path, idMap);
    if (op.type === 'update') {
      return netUpdate(path, op.data).then(function() {
        var p = parsePath(path);
        if (p.store && p.parts.length >= 2) {
          return mergeLocal(p.store, p.parts[1], op.data);
        }
      });
    }
    if (op.type === 'remove') {
      return netRemove(path).then(function() {
        var p = parsePath(path);
        if (p.store) {
          if (p.parts.length === 1) return clearAll(p.store);
          return delOne(p.store, p.parts[1]);
        }
      });
    }
    return Promise.resolve();
  }

  // ------------------------------------------------------------------
  // Sincronização
  // ------------------------------------------------------------------
  function flushOutbox() {
    if (!isOnline() || flushInProgress) return Promise.resolve(false);
    flushInProgress = true;
    var idMap = {};
    return getAllOutbox().then(function(ops) {
      if (!ops.length) { flushInProgress = false; return false; }
      var chain = Promise.resolve();
      ops.forEach(function(op) {
        chain = chain.then(function() {
          return execOp(op, idMap).then(function() {
            return removeOutbox(op.seq);
          });
        }).catch(function(err) {
          console.warn('Operação offline mantida na fila:', err);
          throw err;
        });
      });
      return chain.then(function() { return true; }).catch(function() { return false; });
    }).then(function(flushed) {
      flushInProgress = false;
      if (flushed) notifyStatus();
      return flushed;
    });
  }

  // ------------------------------------------------------------------
  // API pública
  // ------------------------------------------------------------------
  var currentSync = null;

  var OfflineDB = {
    init: function() {
      return openDb();
    },

    setBaseUrl: function(url) {
      baseUrl = url || '';
    },

    setStatusCallback: function(fn) {
      statusCallback = fn;
    },

    isOnline: function() {
      return isOnline();
    },

    // Leitura offline-aware. Quando online, sincroniza a fila pendente
    // ANTES de ler do servidor, garantindo que os dados criados offline
    // apareçam imediatamente no espelho local.
    read: function(path) {
      if (!path) return Promise.resolve(null);
      var beforeRead = isOnline() ? OfflineDB.requestSync() : Promise.resolve(false);
      return beforeRead.then(function() {
        return localRead(path).then(function(local) {
          if (!isOnline()) return local;
          return netRead(path).then(function(net) {
            return mirror(path, net).then(function() {
              scheduleSync();
              return net;
            });
          }).catch(function() {
            return local;
          });
        });
      });
    },

    // Criação offline-aware (retorna key real ou temporária)
    push: function(path, data) {
      var p = parsePath(path);
      var clean = clone(data);
      if (isOnline()) {
        return netPush(path, clean).then(function(key) {
          if (p.store) return putOne(p.store, extend({ id: key }, clean)).then(function() { return key; });
          return key;
        });
      }
      var tId = tempId();
      var localPut = p.store ? putOne(p.store, extend({ id: tId }, clean)) : Promise.resolve();
      return localPut.then(function() {
        return enqueue({ type: 'push', path: path, data: clean, tempId: tId });
      }).then(function() {
        return tId;
      });
    },

    // Atualização offline-aware
    update: function(path, data) {
      var p = parsePath(path);
      var clean = clone(data);
      if (isOnline()) {
        return netUpdate(path, clean).then(function() {
          if (p.store && p.parts.length >= 2) return mergeLocal(p.store, p.parts[1], clean);
          if (p.root === '_initialized') return putOne('meta', { id: '_initialized', value: clean });
        });
      }
      if (p.store && p.parts.length >= 2) {
        return mergeLocal(p.store, p.parts[1], clean).then(function() {
          return enqueue({ type: 'update', path: path, data: clean, id: p.parts[1] });
        });
      }
      return enqueue({ type: 'update', path: path, data: clean, id: null });
    },

    // Remoção offline-aware
    remove: function(path) {
      var p = parsePath(path);
      if (isOnline()) {
        return netRemove(path).then(function() {
          if (p.store) {
            if (p.parts.length === 1) return clearAll(p.store);
            return delOne(p.store, p.parts[1]);
          }
        });
      }
      if (p.store && p.parts.length === 1) {
        return clearAll(p.store).then(function() {
          return enqueue({ type: 'remove', path: path, id: null });
        });
      }
      if (p.store && p.parts.length >= 2) {
        return delOne(p.store, p.parts[1]).then(function() {
          return enqueue({ type: 'remove', path: path, id: p.parts[1] });
        });
      }
      return enqueue({ type: 'remove', path: path, id: null });
    },

    // Escritas "descartáveis" (heartbeat/localização): só quando online
    bestEffortUpdate: function(path, data) {
      if (!isOnline()) return Promise.resolve();
      var p = parsePath(path);
      var clean = clone(data);
      return netUpdate(path, clean).then(function() {
        if (p.store && p.parts.length >= 2) return mergeLocal(p.store, p.parts[1], clean);
      }).catch(function() {});
    },

    bestEffortPush: function(path, data) {
      if (!isOnline()) return Promise.resolve(null);
      var p = parsePath(path);
      var clean = clone(data);
      return netPush(path, clean).then(function(key) {
        if (p.store) return putOne(p.store, extend({ id: key }, clean)).then(function() { return key; });
        return key;
      }).catch(function() { return null; });
    },

    // Envia a fila de operações pendentes
    sync: function() {
      return OfflineDB.requestSync();
    },

    // Força sincronização imediata quando a rede voltar.
    // Se já houver uma sincronização em andamento, retorna a mesma promessa.
    requestSync: function() {
      if (!isOnline()) return Promise.resolve(false);
      if (currentSync) return currentSync;
      currentSync = flushOutbox().then(function(flushed) {
        currentSync = null;
        if (flushed) notifyStatus();
        return flushed;
      }).catch(function() {
        currentSync = null;
        return false;
      });
      return currentSync;
    },

    getPendingCount: function() {
      return getAllOutbox().then(function(ops) { return ops.length; });
    },

    getStatus: function() {
      return getAllOutbox().then(function(ops) {
        return { online: isOnline(), pending: ops.length };
      });
    }
  };

  function notifyStatus() {
    if (statusCallback) statusCallback();
  }

  var scheduleSync = (function() {
    var timer = null;
    return function() {
      if (!isOnline() || timer) return;
      timer = setTimeout(function() {
        timer = null;
        flushOutbox();
      }, 800);
    };
  })();

  window.OfflineDB = OfflineDB;
})();
