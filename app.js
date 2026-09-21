// ===== FIREBASE CONFIG =====
var DB_BASE_URL = 'https://babearia-jhosuan-default-rtdb.firebaseio.com';

// Versão atual do app. Ao publicar uma nova versão, atualize ESTE valor,
// o VERSION em sw.js e o "version" em version.json (devem ser iguais).
var APP_VERSION = '1.3.0';

// ===== UTILITIES =====
var currentUser = null;
var map = null;
var mapMarkers = [];
var refreshInterval = null;
var teamCatalogCache = [];
var userCache = [];
var rulesCache = [];
var adminLocation = null;
var adminAddress = '';
var celebratedTeams = new Set();
var adminLocation = null;
var adminAddress = '';

function $(id) { return document.getElementById(id); }

function toast(text, type) {
  type = type || 'info';
  var container = $('toastContainer');
  var el = document.createElement('div');
  var icons = { success: 'check_circle', error: 'error', warning: 'warning', info: 'info' };
  el.className = 'toast toast-' + type;
  el.innerHTML = '<span class="material-symbols-outlined">' + (icons[type] || 'info') + '</span>' + text;
  container.appendChild(el);
  setTimeout(function() {
    el.classList.add('removing');
    setTimeout(function() { el.remove(); }, 250);
  }, 3500);
}

function showMsg(id, type, text) {
  var el = $(id);
  if (!el) return;
  var icons = { error: 'error', success: 'check_circle', warning: 'warning' };
  el.className = 'msg ' + type;
  el.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px;">' + (icons[type] || 'info') + '</span> ' + text;
  if (type === 'success') {
    setTimeout(function() { el.style.display = 'none'; }, 3500);
  }
}

function clearMsg(id) {
  var el = $(id);
  if (el) { el.className = 'msg'; el.style.display = 'none'; }
}

function showView(id) {
  var views = document.querySelectorAll('.view, #loginView');
  for (var i = 0; i < views.length; i++) views[i].classList.remove('active');
  var target = $(id);
  if (target) target.classList.add('active');
}

function loading(show) {
  $('loadingOverlay').classList.toggle('hidden', !show);
}

function todayStr() {
  var d = new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function formatDateBr(dateStr) {
  var parts = dateStr.split('-');
  return parts[2] + '/' + parts[1] + '/' + parts[0];
}

function escapeHtml(str) {
  if (!str) return '';
  var div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function fmtMoney(v) {
  return 'R$ ' + Number(v).toFixed(2).replace('.', ',');
}

// ===== FIREBASE HELPERS (REST API + OFFLINE) =====
// Todas as chamadas passam pelo OfflineDB (db.js): leem do espelho local
// quando offline e enfileiram escritas para sincronizar quando houver rede.
function fbUrl(path) {
  return DB_BASE_URL + (path ? '/' + path : '') + '.json';
}

function fbOnce(path) {
  return OfflineDB.read(path);
}

function fbPush(path, data) {
  return OfflineDB.push(path, data);
}

function fbUpdate(path, data) {
  return OfflineDB.update(path, data);
}

function fbRemove(path) {
  return OfflineDB.remove(path);
}

function toArray(obj) {
  if (!obj) return [];
  return Object.keys(obj).map(function(k) {
    var item = obj[k];
    if (typeof item === 'object' && item !== null) {
      item.id = k;
    }
    return item;
  });
}

function nowTimestamp() {
  return Date.now();
}

// ===== CACHE DE LEITURA COM TTL (economia de download) =====
// Reutiliza a MESMA Promise em cache por TTL: painéis que leem o mesmo
// caminho várias vezes no ciclo de 30s fazem UM único download compartilhado.
var memoryCache = {};
var CACHE_TTL = 30000;

function fbCached(path, ttl) {
  ttl = ttl || CACHE_TTL;
  var key = path + '|' + ttl;
  var now = Date.now();
  var entry = memoryCache[key];
  if (entry && (now - entry.t) < ttl) return entry.p;
  var p = OfflineDB.readCached(path, ttl).catch(function(err) {
    delete memoryCache[key];
    throw err;
  });
  memoryCache[key] = { t: now, p: p };
  return p;
}

function clearCachedReads() {
  memoryCache = {};
}

// ===== PERÍODO E FUNÇÕES DE ROLE =====
function formatDate(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function currentMonthRange() {
  var now = new Date();
  var start = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-01';
  var end = formatDate(new Date(now.getFullYear(), now.getMonth() + 1, 0));
  return { start: start, end: end };
}

function roleLabel(role) {
  if (role === 'admin') return 'Administrador';
  if (role === 'supervisor') return 'Supervisor';
  if (role === 'equipe') return 'Equipe';
  if (role === 'user') return 'Usuário';
  return role || '';
}

// Equipes que o usuário atual pode VISUALIZAR. admin = todas (null).
function getUserTeamIds() {
  if (!currentUser) return [];
  if (currentUser.role === 'admin') return null;
  if (currentUser.role === 'equipe') return [currentUser.id];
  var list = [];
  var map = currentUser.authorized_teams || {};
  Object.keys(map).forEach(function(k) { if (map[k]) list.push(k); });
  return list;
}

// Verifica se um usuário de monitor (supervisor/user) pode ver determinada equipe
function canViewTeam(userId) {
  var ids = getUserTeamIds();
  if (ids === null) return true;
  return ids.indexOf(userId) !== -1;
}

function isAdmin() {
  return !!(currentUser && currentUser.role === 'admin');
}

function isSupervisor() {
  return !!(currentUser && currentUser.role === 'supervisor');
}

function ensureAdmin() {
  if (isAdmin()) return true;
  toast('Ação restrita ao administrador', 'error');
  return false;
}

// Supervisor e equipe só acessam os últimos 3 dias (hoje até 2 dias atrás).
// O admin não tem limite de período (null).
function daysAgoStr(days) {
  var d = new Date();
  d.setDate(d.getDate() - days);
  return formatDate(d);
}

function getAllowedDateRange() {
  if (isAdmin()) return null;
  return { start: daysAgoStr(2), end: todayStr() };
}

function clampDateToAllowed(value) {
  var range = getAllowedDateRange();
  if (!range || !value) return value;
  if (value < range.start) return range.start;
  if (value > range.end) return range.end;
  return value;
}

// ===== SEED DATA =====
function seedData() {
  return fbOnce('_initialized').then(function(init) {
    if (init) return;
    // offline sem dados locais: não tenta criar seed (evita conflitos)
    if (!navigator.onLine) return;
    var promises = [];
    promises.push(fbPush('users', {
      username: 'ARNALDO.LIMA', password: '159753', role: 'admin',
      latitude: '', longitude: '', last_seen: null, created_at: nowTimestamp()
    }));
    var rules = [
      { class: 'A', min_ups: 42, max_ups: 9999, color: '#2ecc71' },
      { class: 'B', min_ups: 31, max_ups: 41, color: '#3498db' },
      { class: 'C', min_ups: 19, max_ups: 30, color: '#f39c12' },
      { class: 'D', min_ups: 0, max_ups: 18, color: '#e74c3c' }
    ];
    rules.forEach(function(r) { promises.push(fbPush('rules', r)); });
    var catalog = [
      { name: 'Instalacao', ups_value: 10, money_value: 50.00, active: true },
      { name: 'Manutencao', ups_value: 8, money_value: 35.00, active: true },
      { name: 'Suporte', ups_value: 5, money_value: 25.00, active: true }
    ];
    catalog.forEach(function(c) { c.created_at = nowTimestamp(); promises.push(fbPush('catalog_services', c)); });
    promises.push(fbUpdate('', { _initialized: true }));
    return Promise.all(promises);
  });
}

// ===== AUTH =====
function doLogin() {
  var username = $('loginUser').value.trim();
  var password = $('loginPass').value;
  var remember = $('rememberMe').checked;

  if (!username || !password) {
    showMsg('loginMsg', 'error', 'Preencha usuário e senha');
    return;
  }
  clearMsg('loginMsg');
  loading(true);
  fbOnce('users').then(function(users) {
    loading(false);
    if (!users) { showMsg('loginMsg', 'error', 'Nenhum usuário encontrado'); return; }
    var found = null;
    var keys = Object.keys(users);
    for (var i = 0; i < keys.length; i++) {
      var u = users[keys[i]];
      if (u.username === username && u.password === password) {
        found = { id: keys[i], username: u.username, role: u.role || 'equipe', shift_start: u.shift_start || '', shift_end: u.shift_end || '', authorized_teams: u.authorized_teams || {} };
        break;
      }
    }
    if (found) {
      if (remember) {
        localStorage.setItem('ups_user', username);
        localStorage.setItem('ups_pass', password);
      } else {
        localStorage.removeItem('ups_user');
        localStorage.removeItem('ups_pass');
      }
      currentUser = found;
      toast('Bem-vindo, ' + found.username + '!', 'success');
      if (found.role === 'admin' || found.role === 'supervisor') {
        initAdminView();
      } else if (found.role === 'user') {
        initMonitorView(false);
      } else {
        initTeamView();
      }
    } else {
      showMsg('loginMsg', 'error', 'Usuário ou senha inválidos');
    }
}).catch(function(err) {
    loading(false);
    toast('Erro ao fazer login: ' + err.message, 'error');
  });
}

// Compõe as linhas de exportação para uma lista de equipes e período.
function buildCsvReport(teams, start, end) {
  return Promise.all([fbCached('services', 60000), fbCached('shift_notes', CACHE_TTL)]).then(function(results) {
    var allServices = toArray(results[0]);
    var allNotes = toArray(results[1]);
    var notesMap = {};
    allNotes.forEach(function(n) { notesMap[n.team_id + '_' + n.date] = n; });
    var servicesByTeamDate = {};
    allServices.forEach(function(s) {
      if (s.date >= start && s.date <= end) {
        var key = s.user_id + '_' + s.date;
        if (!servicesByTeamDate[key]) servicesByTeamDate[key] = [];
        servicesByTeamDate[key].push(s);
      }
    });
    var filtered = [];
    var currentDate = new Date(start + 'T00:00:00');
    var endDateObj = new Date(end + 'T00:00:00');
    while (currentDate <= endDateObj) {
      var dateStr = currentDate.getFullYear() + '-' + String(currentDate.getMonth() + 1).padStart(2, '0') + '-' + String(currentDate.getDate()).padStart(2, '0');
      var dayOfWeek = currentDate.getDay();
      for (var i = 0; i < teams.length; i++) {
        var t = teams[i];
        var key = t.id + '_' + dateStr;
        var dayServices = servicesByTeamDate[key] || [];
        var isScheduled = t.days_of_week && t.days_of_week.indexOf(dayOfWeek) !== -1;
        var classification = '';
        if (dayServices.length > 0 && isScheduled) {
          classification = 'Abriu';
        } else if (dayServices.length === 0 && isScheduled) {
          classification = 'Não abriu';
        } else if (dayServices.length > 0 && !isScheduled) {
          classification = 'Extra';
        } else {
          continue;
        }
        var noteKey = t.id + '_' + dateStr;
        var note = notesMap[noteKey];
        var motivo = (note && note.reason) ? note.reason : '';
        if (dayServices.length > 0) {
          for (var j = 0; j < dayServices.length; j++) {
            var s = dayServices[j];
            filtered.push({
              equipe: t.username || 'Desconhecido',
              servico: s.service_name,
              ups: s.ups_value,
              quantidade: s.quantity,
              valor_total: s.total_money,
              nota: s.grade,
              data: s.date,
              meta_diaria: t.goal_money || 0,
              classificacao: classification,
              motivo: motivo,
              latitude: s.latitude,
              longitude: s.longitude,
              endereco_equipe: t.address || ''
            });
          }
        } else {
          filtered.push({
            equipe: t.username || 'Desconhecido',
            servico: '',
            ups: 0,
            quantidade: 0,
            valor_total: 0,
            nota: '',
            data: dateStr,
            meta_diaria: t.goal_money || 0,
            classificacao: classification,
            motivo: motivo,
            latitude: '',
            longitude: '',
            endereco_equipe: t.address || ''
          });
        }
      }
      currentDate.setDate(currentDate.getDate() + 1);
    }
    return filtered;
  });
}

function downloadCsv(filtered, filename) {
  var csv = '\uFEFF';
  var headers = Object.keys(filtered[0]);
  csv += headers.join(';') + '\n';
  for (var i = 0; i < filtered.length; i++) {
    var row = headers.map(function(h) { return '"' + String(filtered[i][h]).replace(/"/g, '""') + '"'; });
    csv += row.join(';') + '\n';
  }
  var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  var link = document.createElement('a');
  link.setAttribute('href', URL.createObjectURL(blob));
  link.setAttribute('download', filename);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  toast('Exportação concluída!', 'success');
}

function toggleFullscreen() {
  var mapEl = document.getElementById('map');
  if (!document.fullscreenElement) {
    if (mapEl.requestFullscreen) {
      mapEl.requestFullscreen();
    } else if (mapEl.webkitRequestFullscreen) {
      mapEl.webkitRequestFullscreen();
    } else if (mapEl.msRequestFullscreen) {
      mapEl.msRequestFullscreen();
    }
  } else {
    if (document.exitFullscreen) {
      document.exitFullscreen();
    }
  }
}

function showCelebration(team) {
  var overlay = $('celebrationOverlay');
  var details = $('celebrationDetails');
  details.innerHTML = 'Equipe: <strong>' + escapeHtml(team.username) + '</strong><br>' +
                      'UPS: <strong>' + team.totalUps + '</strong> | R$: <strong>' + fmtMoney(team.totalMoney) + '</strong>';
  overlay.classList.add('active');
  setTimeout(function() {
    overlay.classList.remove('active');
  }, 5000);
}

// ===== TEAM VIEW =====
function initTeamView() {
  $('teamUserName').textContent = currentUser.username;
  $('teamDate').textContent = formatDateBr(todayStr());
  showView('teamView');
  loadTeamCatalog();
  refreshTeamView();
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(refreshTeamView, 30000);
  heartbeat();
  if (window.heartbeatInterval) clearInterval(window.heartbeatInterval);
  window.heartbeatInterval = setInterval(heartbeat, 120000);
  startLocationTracking();
}

function heartbeat() {
  if (!currentUser) return;
  OfflineDB.bestEffortUpdate('users/' + currentUser.id, { last_seen: nowTimestamp() });
}

var watchId = null;
var currentTeamLat = '';
var currentTeamLng = '';
var currentTeamAddress = '';
var currentTeamCity = '';
var lastLocationHistorySave = 0;

function startLocationTracking() {
  if (!navigator.geolocation) return;
  if (watchId !== null) return;
  watchId = navigator.geolocation.watchPosition(function(pos) {
    if (!currentUser) return;
    var lat = pos.coords.latitude;
    var lng = pos.coords.longitude;
    currentTeamLat = lat;
    currentTeamLng = lng;
    OfflineDB.bestEffortUpdate('users/' + currentUser.id, {
      latitude: lat,
      longitude: lng,
      last_seen: nowTimestamp()
    });
    var now = Date.now();
    if (now - lastLocationHistorySave > 60000) {
      lastLocationHistorySave = now;
      saveLocationHistoryPoint(currentUser.id, lat, lng);
    }
  }, function(err) {
    console.warn('Geolocation error:', err.message);
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 300000 });
}

function saveLocationHistoryPoint(userId, lat, lng) {
  var point = {
    lat: lat,
    lng: lng,
    timestamp: nowTimestamp(),
    date: todayStr()
  };
  reverseGeocode(lat, lng, function(addr) {
    point.address = addr;
    var cityParts = addr.split(',');
    point.city = cityParts.length > 1 ? cityParts[1].trim() : cityParts[0].trim();
    currentTeamAddress = addr;
    currentTeamCity = point.city;
    OfflineDB.bestEffortPush('location_history/' + userId + '/' + todayStr(), point);
  });
}

function captureTeamLocationForService(callback) {
  var lat = currentTeamLat;
  var lng = currentTeamLng;
  if (!lat || !lng) {
    if (!navigator.geolocation) {
      callback('', '', '', '');
      return;
    }
    navigator.geolocation.getCurrentPosition(function(pos) {
      currentTeamLat = pos.coords.latitude;
      currentTeamLng = pos.coords.longitude;
      reverseGeocode(currentTeamLat, currentTeamLng, function(addr) {
        currentTeamAddress = addr;
        currentTeamCity = (addr.split(',')[1] || addr.split(',')[0] || '').trim();
        callback(currentTeamLat, currentTeamLng, currentTeamCity, currentTeamAddress);
      });
    }, function(err) {
      callback('', '', '', '');
    }, { enableHighAccuracy: true, timeout: 8000 });
  } else if (currentTeamAddress) {
    callback(lat, lng, currentTeamCity, currentTeamAddress);
  } else {
    reverseGeocode(lat, lng, function(addr) {
      currentTeamAddress = addr;
      currentTeamCity = (addr.split(',')[1] || addr.split(',')[0] || '').trim();
      callback(lat, lng, currentTeamCity, currentTeamAddress);
    });
  }
}

function stopLocationTracking() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
}

function captureAdminLocation() {
  if (!navigator.geolocation) {
    var el = $('locationText');
    if (el) el.textContent = 'Geolocalização não disponível';
    return;
  }
  var icon = $('locationIcon');
  var text = $('locationText');
  if (icon) icon.textContent = 'location_searching';
  if (text) text.textContent = 'Detectando localização...';
  navigator.geolocation.getCurrentPosition(function(pos) {
    adminLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    if (icon) icon.textContent = 'location_on';
    if (text) text.textContent = adminLocation.lat.toFixed(6) + ', ' + adminLocation.lng.toFixed(6);
    reverseGeocode(adminLocation.lat, adminLocation.lng, function(addr) {
      adminAddress = addr;
      if (text) text.textContent = addr + ' (' + adminLocation.lat.toFixed(4) + ', ' + adminLocation.lng.toFixed(4) + ')';
    });
  }, function(err) {
    console.warn('Erro ao capturar localização do admin:', err.message);
    if (icon) icon.textContent = 'location_off';
    if (text) text.textContent = 'Não foi possível obter localização. Clique para tentar novamente.';
  }, { enableHighAccuracy: true, timeout: 10000 });
}

function reverseGeocode(lat, lng, callback) {
  var url = 'https://nominatim.openstreetmap.org/reverse?format=json&lat=' + lat + '&lon=' + lng + '&addressdetails=1&accept-language=pt';
  fetch(url, { headers: { 'User-Agent': 'UPS-System/1.0' } })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var addr = data.display_name || (lat.toFixed(4) + ', ' + lng.toFixed(4));
      callback(addr);
    })
    .catch(function() {
      callback(lat.toFixed(4) + ', ' + lng.toFixed(4));
    });
}

function loadTeamCatalog() {
  fbOnce('catalog_services').then(function(services) {
    var arr = toArray(services).filter(function(s) { return s.active; });
    teamCatalogCache = arr;
    var container = $('teamActivitiesList');
    container.innerHTML = '';
    if (!arr || arr.length === 0) {
      container.innerHTML = '<div class="empty-state">Nenhum serviço disponível</div>';
      return;
    }
    for (var i = 0; i < arr.length; i++) {
      var svc = arr[i];
      var div = document.createElement('div');
      div.className = 'activity-item';
      div.innerHTML = '<input type="radio" name="teamActivityRadio" id="rad_' + svc.id + '" value="' + svc.id + '" onchange="onTeamActivityToggle(\'' + svc.id + '\')">' +
                      '<label for="rad_' + svc.id + '">' + escapeHtml(svc.name) + ' <span style="font-size:10px;color:var(--text-muted);">(' + svc.ups_value + ' UPS)</span></label>';
      container.appendChild(div);
    }
  });
}

function onTeamEntryTypeChange() {
  $('teamDynamicQuantities').innerHTML = '';
  onTeamGradeChange();
}

function onTeamActivityToggle(svcId) {
  var qtyContainer = $('teamDynamicQuantities');
  qtyContainer.innerHTML = '';
  var svc = teamCatalogCache.find(function(s) { return s.id == svcId; });
  if (svc) {
    var div = document.createElement('div');
    div.className = 'qty-input-row';
    div.id = 'qty_row_' + svcId;
    div.innerHTML = '<label>' + escapeHtml(svc.name) + '</label>' +
                    '<input type="number" id="qty_' + svcId + '" value="1" min="1" oninput="onTeamGradeChange()">';
    qtyContainer.appendChild(div);
  }
  onTeamGradeChange();
}

function fmtUps(v) {
  var n = Number(v);
  if (n === Math.floor(n)) return String(n);
  return n.toFixed(1).replace('.', ',');
}

function onTeamGradeChange() {
  var raw = $('teamGrade').value;
  var nota = parseInt(raw);
  if (isNaN(nota)) nota = 0;
  var type = $('teamEntryType').value;
  var calc = $('teamCalcDisplay');
  var totalUps = 0;
  var totalMoney = 0;
  var totalQty = 0;
  var selectedRadio = document.querySelector('input[name="teamActivityRadio"]:checked');
  if (selectedRadio) {
    var svcId = selectedRadio.value;
    var svc = teamCatalogCache.find(function(s) { return s.id == svcId; });
    if (svc) {
      var qtyInput = $('qty_' + svcId);
      var qty = qtyInput ? parseFloat(qtyInput.value) || 1 : 1;
      totalQty = qty;
      if (type !== 'miscellany') {
        totalUps = qty * (svc.ups_value || 0);
      } else {
        totalUps = 5.6;
      }
      totalMoney = qty * (svc.money_value || 0);
    }
  }
  if (totalUps > 0 || type === 'emergency' || type === 'commercial') {
    calc.style.display = 'flex';
    $('teamCalcUps').textContent = fmtUps(totalUps);
    $('teamCalcMoney').textContent = fmtMoney(totalMoney);
    if ($('teamCalcQty')) $('teamCalcQty').textContent = totalQty;
    if ($('teamCalcGrade')) $('teamCalcGrade').textContent = nota;
  } else {
    calc.style.display = 'none';
  }
}

function addTeamService() {
  var type = $('teamEntryType').value;
  var raw = $('teamGrade').value;
  var nota = parseInt(raw);
  if (isNaN(nota)) { showMsg('teamFormMsg', 'error', 'Informe uma nota válida'); return; }
  var selectedRadio = document.querySelector('input[name="teamActivityRadio"]:checked');
  if (!selectedRadio) { showMsg('teamFormMsg', 'error', 'Selecione exatamente uma atividade'); return; }
  var svcId = selectedRadio.value;
  var svc = teamCatalogCache.find(function(s) { return s.id == svcId; });
  if (!svc) { showMsg('teamFormMsg', 'error', 'Atividade não encontrada'); return; }
  var qtyInput = $('qty_' + svcId);
  var qty = qtyInput ? parseFloat(qtyInput.value) || 1 : 1;
  var totalUps;
  var totalMoney = 0;
  if (type === 'miscellany') {
    totalUps = 5.6;
  } else {
    totalUps = qty * (svc.ups_value || 0);
  }
  totalMoney = qty * (svc.money_value || 0);

  loading(true);
  // Consulta no servidor APENAS os serviços desta equipe (economia de download)
  OfflineDB.query('services', { orderBy: 'user_id', equalTo: currentUser.id, limitToLast: 2000 }).then(function(arr) {
    var duplicateGrade = (arr || []).some(function(s) {
      return s.grade === nota && s.grade > 0;
    });
    if (duplicateGrade) {
      loading(false);
      showMsg('teamFormMsg', 'error', 'Esta nota (' + nota + ') já foi utilizada por esta equipe. Informe um número de nota diferente.');
      return;
    }
    captureTeamLocationForService(function(lat, lng, city, address) {
      var selectedSvcs = [{ svc: svc, qty: qty }];
      submitNewEntry(type, nota, selectedSvcs, totalUps, totalMoney, lat, lng, city, address);
    });
  }).catch(function(err) {
    loading(false);
    showMsg('teamFormMsg', 'error', 'Erro ao validar nota: ' + err.message);
  });
}

function submitNewEntry(type, grade, selectedSvcs, upsValue, moneyValue, lat, lng, city, address) {
  var svcNames = selectedSvcs.map(function(s) { return s.svc.name; }).join(', ');
  var totalQty = selectedSvcs.reduce(function(sum, s) { return sum + s.qty; }, 0);
  var upsPerUnit = totalQty > 0 ? upsValue / totalQty : upsValue;
  var moneyPerUnit = totalQty > 0 && moneyValue > 0 ? moneyValue / totalQty : 0;
  var typeLabel = type === 'miscellany' ? 'Miscelânea' : (type === 'emergency' ? 'Emergência' : (type === 'commercial' ? 'Comercial' : ''));
  var now = new Date();
  var timeStr = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') + ':' + String(now.getSeconds()).padStart(2, '0');
  var serviceData = {
    user_id: currentUser.id,
    service_name: typeLabel + ': ' + svcNames,
    ups_value: upsValue,
    quantity: totalQty,
    ups_per_unit: upsPerUnit,
    money_per_unit: moneyPerUnit,
    total_money: moneyValue,
    grade: grade,
    type: type,
    activities: selectedSvcs.map(function(s) { return { id: s.svc.id, name: s.svc.name, qty: s.qty }; }),
    date: todayStr(),
    created_at: nowTimestamp(),
    latitude: lat || '',
    longitude: lng || '',
    city: city || '',
    address: address || '',
    time: timeStr,
    edited_by: '',
    edited_at: null
  };
  fbPush('services', serviceData).then(function(key) {
    loading(false);
    $('teamGrade').value = '';
    $('teamEntryType').value = 'miscellany';
    var radios = document.querySelectorAll('input[name="teamActivityRadio"]');
    for (var i = 0; i < radios.length; i++) radios[i].checked = false;
    $('teamDynamicQuantities').innerHTML = '';
    toast('Registro adicionado!', 'success');
    refreshTeamView();
    updateSyncStatus();
    return OfflineDB.bestEffortUpdate('users/' + currentUser.id, { last_seen: nowTimestamp() });
  }).catch(function(err) {
    loading(false);
    showMsg('teamFormMsg', 'error', 'Erro: ' + err.message);
  });
}

function submitService(svc, qty, grade, totalUps, totalMoney, lat, lng) {
  clearMsg('teamFormMsg');
  loading(true);
  var serviceData = {
    user_id: currentUser.id,
    service_name: svc.name,
    ups_value: totalUps,
    quantity: qty,
    ups_per_unit: svc.ups_value,
    money_per_unit: svc.money_value,
    total_money: totalMoney,
    grade: grade,
    type: 'catalog',
    latitude: lat || '',
    longitude: lng || '',
    catalog_service_id: svc.id,
    date: todayStr(),
    created_at: nowTimestamp()
  };
  fbPush('services', serviceData).then(function(key) {
    loading(false);
    if ($('teamCatalogSelect')) $('teamCatalogSelect').value = '';
    if ($('teamQuantity')) $('teamQuantity').value = '1';
    if ($('teamGrade')) $('teamGrade').value = '0';
    var calc = $('teamCalcDisplay');
    if (calc) calc.style.display = 'none';
    toast('Serviço adicionado!', 'success');
    refreshTeamView();
    updateSyncStatus();
    return OfflineDB.bestEffortUpdate('users/' + currentUser.id, { last_seen: nowTimestamp() });
  }).catch(function(err) {
    loading(false);
    showMsg('teamFormMsg', 'error', 'Erro: ' + err.message);
  });
}

function refreshTeamView() {
  if (!currentUser) return;
  getTeamSummary(currentUser.id, todayStr(), todayStr()).then(function(summary) {
    renderTeamSummary(summary);
    renderTeamServices(summary.services);
    lastShift = { shift_start: summary.shift_start, shift_end: summary.shift_end };
    renderTeamShift();
  }).catch(function(err) {
    console.error('Erro ao atualizar:', err);
  });
}

function renderTeamSummary(summary) {
  var badge = $('teamBadge');
  badge.textContent = summary.class;
  badge.style.background = summary.color || '#94a3b8';
  $('teamTotal').textContent = summary.totalUps;
  $('teamTotalMoney').textContent = fmtMoney(summary.totalMoney || 0);
  $('teamCount').textContent = summary.count + ' servi\u00E7o' + (summary.count !== 1 ? 's' : '') + ' hoje';
  var goalSection = $('teamGoalSection');
  if (summary.goal_money > 0) {
    var goalPct = Math.min(100, Math.round((summary.totalMoney / summary.goal_money) * 100));
    goalSection.style.display = 'block';
    $('teamGoalValue').textContent = fmtMoney(summary.goal_money);
    $('teamGoalPercent').textContent = goalPct + '%';
    $('teamGoalBar').style.width = Math.min(100, (summary.totalMoney / summary.goal_money) * 100) + '%';
    $('teamGoalBar').style.background = goalPct >= 100 ? 'var(--success)' : goalPct >= 70 ? 'var(--warning)' : 'var(--money)';
  } else {
    goalSection.style.display = 'none';
  }
}

function renderTeamServices(services) {
  var container = $('teamServiceList');
  if (!services || services.length === 0) {
    container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">assignment</span><p>Nenhum servi\u00E7o registrado hoje</p></div>';
    return;
  }
  var html = '<div class="service-list">';
  for (var i = 0; i < services.length; i++) {
    var s = services[i];
    var detail = '';
    if (s.quantity > 1) {
      detail = s.quantity + ' un \u00D7 ' + s.upsPerUnit + ' UPS = ' + s.upsValue + ' UPS';
      if (s.totalMoney) detail += ' | ' + fmtMoney(s.totalMoney);
    } else if (s.totalMoney) {
      detail = fmtMoney(s.totalMoney);
    }
    if (s.grade > 0) detail += (detail ? ' | ' : '') + 'Nota: ' + s.grade;
    html += '<div class="service-item">' +
      '<div class="srv-icon"><span class="material-symbols-outlined">task_alt</span></div>' +
      '<div class="srv-body">' +
      '<span class="name">' + escapeHtml(s.serviceName) + '</span>' +
      (detail ? '<span class="detail">' + detail + '</span>' : '') +
      '</div>' +
      '<div class="srv-values">' +
      (s.grade > 0 ? '<span class="grade-display">' + s.grade + '</span>' : '') +
      '<span class="ups">' + s.upsValue + ' UPS</span>' +
      (s.totalMoney ? '<span class="money">' + fmtMoney(s.totalMoney) + '</span>' : '') +
      '</div>' +
      '<button class="del-btn" onclick="deleteService(\'' + s.id + '\')" title="Remover"><span class="material-symbols-outlined">close</span></button>' +
      '</div>';
  }
  html += '</div>';
  container.innerHTML = html;
}

function deleteService(serviceId) {
  if (!confirm('Remover este servi\u00E7o?')) return;
  loading(true);
  fbRemove('services/' + serviceId).then(function() {
    loading(false);
    toast('Serviço removido', 'info');
    updateSyncStatus();
    refreshTeamView();
  }).catch(function(err) {
    loading(false);
    toast('Erro: ' + err.message, 'error');
  });
}

// ===== TURNO (HORÁRIO DA EQUIPE) =====
var lastShift = null;

function getShiftProgress(user) {
  var start = user && user.shift_start;
  var end = user && user.shift_end;
  if (!start || !end) return { enabled: false };
  var sp = start.split(':').map(Number);
  var ep = end.split(':').map(Number);
  if (isNaN(sp[0]) || isNaN(sp[1]) || isNaN(ep[0]) || isNaN(ep[1])) return { enabled: false };
  var now = new Date();
  var startMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), sp[0], sp[1]).getTime();
  var endMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), ep[0], ep[1]).getTime();
  if (endMs <= startMs) endMs += 86400000;
  var nowMs = now.getTime();
  var result = { enabled: true, start: start, end: end, pct: 0 };
  if (nowMs < startMs) {
    result.status = 'antes';
    result.label = 'Início às ' + start;
    result.pct = 0;
  } else if (nowMs > endMs) {
    result.status = 'depois';
    result.label = 'Turno encerrado';
    result.pct = 100;
  } else {
    var total = endMs - startMs;
    var elapsed = nowMs - startMs;
    result.status = 'durante';
    result.pct = Math.min(100, Math.max(0, Math.round((elapsed / total) * 100)));
    result.remaining = endMs - nowMs;
    result.label = 'Faltam ' + formatDuration(result.remaining);
  }
  return result;
}

function formatDuration(ms) {
  var totalMin = Math.max(0, Math.round(ms / 60000));
  var h = Math.floor(totalMin / 60);
  var m = totalMin % 60;
  if (h > 0) return h + 'h' + (m > 0 ? ' ' + m + 'min' : '');
  return m + 'min';
}

function shiftColor(sp) {
  if (sp.status === 'durante') {
    if (sp.pct >= 85) return 'var(--danger)';
    if (sp.pct >= 60) return 'var(--warning)';
    return 'var(--primary)';
  }
  return 'var(--text-muted)';
}

function renderTeamShift() {
  var section = $('teamShiftSection');
  if (!section) return;
  var sp = getShiftProgress(lastShift || currentUser);
  if (!sp.enabled) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  $('teamShiftTimes').textContent = sp.start + ' – ' + sp.end;
  $('teamShiftLabel').textContent = sp.label;
  var bar = $('teamShiftBar');
  bar.style.width = sp.pct + '%';
  bar.style.background = shiftColor(sp);
}

function shiftMiniBar(user) {
  var sp = getShiftProgress(user);
  if (!sp.enabled) return '';
  var color = shiftColor(sp);
  return '<div style="margin-top:4px;">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;">' +
    '<span style="font-size:10px;color:var(--text-muted);">Turno: ' + sp.start + ' – ' + sp.end + '</span>' +
    '<span style="font-size:10px;font-weight:700;color:' + color + ';">' + sp.label + '</span>' +
    '</div>' +
    '<div style="width:100%;height:6px;background:var(--border);border-radius:3px;overflow:hidden;">' +
    '<div style="height:100%;background:' + color + ';border-radius:3px;width:' + sp.pct + '%;"></div>' +
    '</div></div>';
}

// ===== DATA FUNCTIONS =====
function getTeamSummary(userId, startDate, endDate) {
  return Promise.all([
    OfflineDB.query('services', { orderBy: 'user_id', equalTo: userId, limitToLast: 4000 }).catch(function() { return []; }),
    fbCached('users/' + userId, CACHE_TTL)
  ]).then(function(results) {
    var allServices = results[0];
    var userData = results[1];
    var filtered = allServices.filter(function(s) {
      return s.date >= startDate && s.date <= endDate;
    });
    var services = filtered.map(function(s) { return formatService(s); });
    var totalUps = services.reduce(function(sum, sv) { return sum + sv.upsValue; }, 0);
    var totalMoney = services.reduce(function(sum, sv) { return sum + (sv.totalMoney || 0); }, 0);
    var classInfo = getClassification(totalUps);
    return {
      userId: userId, startDate: startDate, endDate: endDate,
      goal_money: (userData && userData.goal_money) || 0,
      shift_start: (userData && userData.shift_start) || '',
      shift_end: (userData && userData.shift_end) || '',
      services: services, totalUps: totalUps, totalMoney: totalMoney,
      class: classInfo.class, color: classInfo.color, count: services.length
    };
  });
}

function getAllTeamsSummaryForPeriod(startDate, endDate) {
  return Promise.all([fbCached('users', CACHE_TTL), fbCached('services', CACHE_TTL)]).then(function(results) {
    var users = toArray(results[0]);
    var allServices = toArray(results[1]);
    return users.filter(function(u) { return u.role !== 'admin' && canViewTeam(u.id); }).map(function(user) {
      var svcs = allServices.filter(function(s) {
        return s.user_id === user.id && s.date >= startDate && s.date <= endDate;
      });
      var services = svcs.map(function(s) { return formatService(s); });
      var totalUps = services.reduce(function(sum, sv) { return sum + sv.upsValue; }, 0);
      var totalMoney = services.reduce(function(sum, sv) { return sum + (sv.totalMoney || 0); }, 0);
      var classInfo = getClassification(totalUps);
      return {
        userId: user.id, username: user.username,
        supervisor: user.supervisor || '',
        goal_money: user.goal_money || 0,
        shift_start: user.shift_start || '',
        shift_end: user.shift_end || '',
        latitude: user.latitude || '', longitude: user.longitude || '',
        address: user.address || '',
        lastSeen: user.last_seen || null,
        services: services, totalUps: totalUps, totalMoney: totalMoney,
        class: classInfo.class, color: classInfo.color, count: services.length
      };
    });
  });
}

function loadStatistics() {
  var start = $('adminStartDate').value;
  var end = $('adminEndDate').value;
  Promise.all([fbCached('services', CACHE_TTL), fbCached('users', CACHE_TTL), fbCached('catalog_services', 60000)]).then(function(results) {
    var allServices = toArray(results[0]);
    var users = toArray(results[1]);
    var catalog = toArray(results[2]);
    var filtered = allServices.filter(function(s) { return s.date >= start && s.date <= end && canViewTeam(s.user_id); });

    var totalUps = filtered.reduce(function(s, sv) { return s + (sv.ups_value || 0); }, 0);
    var totalMoney = filtered.reduce(function(s, sv) { return s + (sv.total_money || 0); }, 0);
    var grades = filtered.filter(function(s) { return s.grade > 0; }).map(function(s) { return s.grade; });
    var totalGradeCount = grades.length;

    var userMap = {};
    users.forEach(function(u) { userMap[u.id] = u.username; });

    var svcCount = {};
    var svcUps = {};
    filtered.forEach(function(s) {
      var name = s.service_name || 'Desconhecido';
      svcCount[name] = (svcCount[name] || 0) + (s.quantity || 1);
      svcUps[name] = (svcUps[name] || 0) + (s.ups_value || 0);
    });

    var svcNames = Object.keys(svcCount).sort(function(a, b) { return svcCount[b] - svcCount[a]; });
    var topService = svcNames.length > 0 ? svcNames[0] : 'Nenhum';
    var topServiceCount = topService !== 'Nenhum' ? svcCount[topService] : 0;

    var dailyData = {};
    filtered.forEach(function(s) {
      if (!dailyData[s.date]) dailyData[s.date] = { ups: 0, money: 0, count: 0 };
      dailyData[s.date].ups += s.ups_value || 0;
      dailyData[s.date].money += s.total_money || 0;
      dailyData[s.date].count += s.quantity || 1;
    });
    var dates = Object.keys(dailyData).sort();

    var topTeams = {};
    filtered.forEach(function(s) {
      if (!topTeams[s.user_id]) topTeams[s.user_id] = { ups: 0, money: 0, count: 0, grades: [] };
      topTeams[s.user_id].ups += s.ups_value || 0;
      topTeams[s.user_id].money += s.total_money || 0;
      topTeams[s.user_id].count += s.quantity || 1;
      if (s.grade > 0) topTeams[s.user_id].grades.push(s.grade);
    });
    var teamRanking = Object.keys(topTeams).map(function(uid) {
      var g = topTeams[uid].grades;
      return {
        userId: uid, username: userMap[uid] || 'Desconhecido',
        ups: topTeams[uid].ups, money: topTeams[uid].money,
        count: topTeams[uid].count,
        totalGradeCount: g.length
      };
    }).sort(function(a, b) { return b.ups - a.ups; });

    renderStatistics({
      totalUps: totalUps, totalMoney: totalMoney, totalServices: filtered.length,
      totalGradeCount: totalGradeCount, topService: topService, topServiceCount: topServiceCount,
      svcCount: svcCount, svcUps: svcUps, svcNames: svcNames,
      dailyData: dailyData, dates: dates,
      teamRanking: teamRanking
    });
  }).catch(function(err) {
    console.error('Erro ao carregar estatísticas:', err);
  });
}

function renderStatistics(stats) {
  var container = $('statsContent');
  if (!container) return;
  var html = '';

  html += '<div class="stats-overview">' +
    '<div class="stat-box"><span class="stat-box-icon ups"><span class="material-symbols-outlined">trending_up</span></span><div><div class="stat-box-value">' + stats.totalUps + '</div><div class="stat-box-label">Total UPS</div></div></div>' +
    '<div class="stat-box"><span class="stat-box-icon money"><span class="material-symbols-outlined">payments</span></span><div><div class="stat-box-value">' + fmtMoney(stats.totalMoney) + '</div><div class="stat-box-label">Total R$</div></div></div>' +
    '<div class="stat-box"><span class="stat-box-icon services"><span class="material-symbols-outlined">assignment</span></span><div><div class="stat-box-value">' + stats.totalServices + '</div><div class="stat-box-label">Serviços</div></div></div>' +
    '<div class="stat-box"><span class="stat-box-icon grade"><span class="material-symbols-outlined">star</span></span><div><div class="stat-box-value">' + stats.totalGradeCount + '</div><div class="stat-box-label">Total Notas</div></div></div>' +
    '<div class="stat-box"><span class="stat-box-icon teams"><span class="material-symbols-outlined">signal_cellular_alt</span></span><div><div class="stat-box-value">' + escapeHtml(stats.topService) + '</div><div class="stat-box-label">Serviço Top</div></div></div>' +
    '<div class="stat-box"><span class="stat-box-icon online"><span class="material-symbols-outlined">repeat</span></span><div><div class="stat-box-value">' + stats.topServiceCount + '</div><div class="stat-box-label">Execuções Top</div></div></div>' +
    '</div>';

  html += '<div class="card" style="margin-bottom:16px;"><div class="card-title"><span class="material-symbols-outlined">bar_chart</span> Distribuição de Serviços</div>';
  if (stats.svcNames.length > 0) {
    var maxCount = stats.svcCount[stats.svcNames[0]];
    html += '<div class="chart-bars">';
    for (var i = 0; i < stats.svcNames.length; i++) {
      var name = stats.svcNames[i];
      var count = stats.svcCount[name];
      var pct = maxCount > 0 ? (count / maxCount) * 100 : 0;
      html += '<div class="chart-row"><div class="chart-label">' + escapeHtml(name) + '</div><div class="chart-track"><div class="chart-fill" style="width:' + pct + '%;"></div></div><div class="chart-value">' + count + 'x</div></div>';
    }
    html += '</div>';
  } else {
    html += '<div class="empty-state"><p>Nenhum serviço no período</p></div>';
  }
  html += '</div>';

  if (stats.dates.length > 0) {
    html += '<div class="card" style="margin-bottom:16px;"><div class="card-title"><span class="material-symbols-outlined">calendar_month</span> Evolução Diária</div><div class="chart-bars">';
    var maxDaily = stats.dates.reduce(function(m, d) { return Math.max(m, stats.dailyData[d].ups); }, 0);
    for (var i = 0; i < stats.dates.length; i++) {
      var d = stats.dates[i];
      var dd = stats.dailyData[d];
      var pctDaily = maxDaily > 0 ? (dd.ups / maxDaily) * 100 : 0;
      html += '<div class="chart-row"><div class="chart-label" style="min-width:90px;">' + formatDateBr(d) + '</div><div class="chart-track"><div class="chart-fill daily" style="width:' + pctDaily + '%;"></div></div><div class="chart-value">' + dd.ups + ' UPS</div></div>';
    }
    html += '</div></div>';
  }

  html += '<div class="card"><div class="card-title"><span class="material-symbols-outlined">leaderboard</span> Ranking de Equipes (UPS)</div>';
  if (stats.teamRanking.length > 0) {
    html += '<div class="table-wrap"><table><thead><tr><th>#</th><th>Equipe</th><th>UPS</th><th>R$</th><th>Serviços</th><th>Notas</th></tr></thead><tbody>';
    for (var i = 0; i < stats.teamRanking.length; i++) {
      var tr = stats.teamRanking[i];
      html += '<tr>' +
        '<td style="font-weight:700;">' + (i + 1) + '</td>' +
        '<td><strong>' + escapeHtml(tr.username) + '</strong></td>' +
        '<td style="font-weight:700;color:var(--primary);">' + tr.ups + '</td>' +
        '<td style="color:var(--money);font-weight:600;">' + fmtMoney(tr.money) + '</td>' +
        '<td>' + tr.count + '</td>' +
        '<td>' + (tr.totalGradeCount > 0 ? tr.totalGradeCount : '-') + '</td>' +
        '</tr>';
    }
    html += '</tbody></table></div>';
  } else {
    html += '<div class="empty-state"><p>Nenhum dado no período</p></div>';
  }
  html += '</div>';

  container.innerHTML = html;
}

function formatService(s) {
  return {
    id: s.id,
    userId: s.user_id,
    serviceName: s.service_name,
    upsValue: s.ups_value || 0,
    quantity: s.quantity || 1,
    upsPerUnit: s.ups_per_unit || s.ups_value || 0,
    moneyPerUnit: s.money_per_unit || 0,
    totalMoney: s.total_money || 0,
    grade: s.grade || 0,
    latitude: s.latitude || '',
    longitude: s.longitude || '',
    city: s.city || '',
    address: s.address || '',
    time: s.time || '',
    date: s.date,
    type: s.type || 'catalog',
    activities: s.activities || [],
    editedBy: s.edited_by || '',
    editedAt: s.edited_at || null
  };
}

function getClassification(totalUps) {
  if (!rulesCache || rulesCache.length === 0) {
    return { class: '-', color: '#94a3b8' };
  }
  for (var i = rulesCache.length - 1; i >= 0; i--) {
    var r = rulesCache[i];
    if (totalUps >= r.minUps && totalUps <= r.maxUps) {
      return { class: r.class, color: r.color };
    }
  }
  return { class: '-', color: '#94a3b8' };
}

// ===== LOGOUT =====
function logout() {
  if (refreshInterval) clearInterval(refreshInterval);
  if (window.heartbeatInterval) clearInterval(window.heartbeatInterval);
  stopLocationTracking();
  currentUser = null;
  monitorLocked = false;
  celebratedTeams = new Set();
  clearCachedReads();
  showView('loginView');
  toast('Sessão encerrada', 'info');
}

// ===== MONITOR VIEW (SUPERVISOR / USUÁRIO) =====
// O supervisor tem a visão TRAVADA no mês vigente (sem seletor de data).
// O usuário (role 'user') pode escolher o período livremente.
var monitorLocked = false;

function initMonitorView(locked) {
  monitorLocked = !!locked;
  $('monUserName').textContent = currentUser.username + ' · ' + roleLabel(currentUser.role);
  var range = getMonitorRange();
  $('monPeriod').textContent = formatDateBr(range.start) + ' a ' + formatDateBr(range.end) + (monitorLocked ? ' · Mês vigente' : '');
  var banner = $('monLockBanner');
  var filters = $('monFilters');
  if (monitorLocked) {
    if (banner) banner.style.display = 'flex';
    if (filters) filters.style.display = 'none';
  } else {
    if (banner) banner.style.display = 'none';
    if (filters) {
      filters.style.display = 'flex';
      $('monStartDate').value = range.start;
      $('monEndDate').value = range.end;
    }
  }
  showView('monitorView');
  loadMonitorView();
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(loadMonitorView, 30000);
}

// Supervisor: sempre o mês vigente (bloqueado). Usuário: período selecionado.
function getMonitorRange() {
  if (monitorLocked) return currentMonthRange();
  var start = $('monStartDate') && $('monStartDate').value;
  var end = $('monEndDate') && $('monEndDate').value;
  if (!start || !end) return currentMonthRange();
  return { start: start, end: end };
}

// Equipes autorizadas do usuário atual (sem admin)
function getMonitorTeamUsers() {
  return fbCached('users', CACHE_TTL).then(function(users) {
    var arr = toArray(users);
    var teams = arr.filter(function(u) { return u.role === 'equipe'; });
    var ids = getUserTeamIds();
    if (ids === null) return teams;
    var idMap = {};
    ids.forEach(function(i) { idMap[i] = true; });
    return teams.filter(function(u) { return idMap[u.id]; });
  });
}

function loadMonitorView() {
  if (!currentUser) return;
  var range = getMonitorRange();
  var periodEl = $('monPeriod');
  if (periodEl) periodEl.textContent = formatDateBr(range.start) + ' a ' + formatDateBr(range.end) + (monitorLocked ? ' · Mês vigente' : '');
  loading(true);
  Promise.all([fbCached('rules', CACHE_TTL), getMonitorTeamUsers(), fbCached('catalog_services', 60000)]).then(function(results) {
    var rules = toArray(results[0]);
    if (rules.length) {
      rulesCache = rules.map(function(r) {
        return { id: r.id, class: r.class, minUps: r.min_ups, maxUps: r.max_ups, color: r.color };
      });
    }
    var teams = results[1];
    loadMonitorServices(teams, range.start, range.end);
  }).catch(function(err) {
    loading(false);
    console.error('Erro ao carregar monitor:', err);
  });
}

// Baixa APENAS os serviços das equipes vinculadas (query no servidor)
// e filtra o período no cliente (o RTDB não combina orderBy com faixa de data).
function loadMonitorServices(teams, start, end) {
  var teamIds = teams.map(function(t) { return t.id; });
  if (teamIds.length === 0) {
    loading(false);
    renderMonitorSummary([]);
    renderMonitorTeams([]);
    return;
  }
  var queries = teamIds.map(function(id) {
    return OfflineDB.query('services', { orderBy: 'user_id', equalTo: id, limitToLast: 3000 }).catch(function() { return []; });
  });
  Promise.all(queries).then(function(results) {
    loading(false);
    var teamsData = teams.map(function(team, i) {
      var recs = results[i] || [];
      var svcs = recs.filter(function(s) { return s.date >= start && s.date <= end; });
      var services = svcs.map(function(s) { return formatService(s); });
      var totalUps = services.reduce(function(sum, sv) { return sum + sv.upsValue; }, 0);
      var totalMoney = services.reduce(function(sum, sv) { return sum + (sv.totalMoney || 0); }, 0);
      var classInfo = getClassification(totalUps);
      return {
        userId: team.id, username: team.username,
        supervisor: team.supervisor || '',
        goal_money: team.goal_money || 0,
        shift_start: team.shift_start || '', shift_end: team.shift_end || '',
        latitude: team.latitude || '', longitude: team.longitude || '',
        address: team.address || '', lastSeen: team.last_seen || null,
        services: services, totalUps: totalUps, totalMoney: totalMoney,
        class: classInfo.class, color: classInfo.color, count: services.length
      };
    });
    renderMonitorSummary(teamsData);
    renderMonitorTeams(teamsData);
  }).catch(function(err) {
    loading(false);
    console.error('Erro ao carregar serviços do monitor:', err);
  });
}

function renderMonitorSummary(teamsData) {
  var container = $('monSummaries');
  if (!container) return;
  if (!teamsData || teamsData.length === 0) {
    container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">groups</span><p>Nenhuma equipe vinculada. Procure o administrador.</p></div>';
    return;
  }
  var totalUps = teamsData.reduce(function(s, t) { return s + t.totalUps; }, 0);
  var totalMoney = teamsData.reduce(function(s, t) { return s + t.totalMoney; }, 0);
  var totalCount = teamsData.reduce(function(s, t) { return s + t.count; }, 0);
  var gradeCount = 0;
  teamsData.forEach(function(t) {
    t.services.forEach(function(s) { if (s.grade > 0) gradeCount++; });
  });
  var html = '<div class="stats-overview">' +
    '<div class="stat-box"><span class="stat-box-icon teams"><span class="material-symbols-outlined">groups</span></span><div><div class="stat-box-value">' + teamsData.length + '</div><div class="stat-box-label">Equipes</div></div></div>' +
    '<div class="stat-box"><span class="stat-box-icon ups"><span class="material-symbols-outlined">trending_up</span></span><div><div class="stat-box-value">' + totalUps + '</div><div class="stat-box-label">Total UPS</div></div></div>' +
    '<div class="stat-box"><span class="stat-box-icon money"><span class="material-symbols-outlined">payments</span></span><div><div class="stat-box-value">' + fmtMoney(totalMoney) + '</div><div class="stat-box-label">Total R$</div></div></div>' +
    '<div class="stat-box"><span class="stat-box-icon services"><span class="material-symbols-outlined">assignment</span></span><div><div class="stat-box-value">' + totalCount + '</div><div class="stat-box-label">Serviços</div></div></div>' +
    '<div class="stat-box"><span class="stat-box-icon grade"><span class="material-symbols-outlined">star</span></span><div><div class="stat-box-value">' + gradeCount + '</div><div class="stat-box-label">Notas</div></div></div>' +
    '</div>';
  container.innerHTML = html;
}

function renderMonitorTeams(teamsData) {
  var container = $('monTeamsContent');
  if (!container) return;
  if (!teamsData || teamsData.length === 0) {
    container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">groups</span><p>Nenhuma equipe vinculada à sua conta.</p></div>';
    return;
  }
  var sorted = teamsData.slice().sort(function(a, b) { return b.totalUps - a.totalUps; });
  var html = '';
  for (var i = 0; i < sorted.length; i++) {
    var t = sorted[i];
    var medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '#' + (i + 1);
    var color = t.color || '#94a3b8';
    var statusInfo = getStatusInfo(t.lastSeen);
    var accId = 'monAcc_' + i;
    var goalPct = t.goal_money > 0 ? Math.min(100, Math.round((t.totalMoney / t.goal_money) * 100)) : 0;
    html += '<div class="card" style="margin-bottom:8px;overflow:hidden;">';
    html += '<div class="ranking-item" style="cursor:pointer;padding:12px 14px;margin:0;border:none;border-radius:0;" onclick="toggleMonitorTeam(\'' + accId + '\')">' +
      '<div class="ranking-pos">' + medal + '</div>' +
      '<div class="badge badge-sm" style="background:' + color + ';">' + t.class + '</div>' +
      '<div class="ranking-info">' +
      '<div class="ranking-name">' + escapeHtml(t.username) + '</div>' +
      '<div class="ranking-status ' + statusInfo.className + '"><span class="status-dot"></span><span class="status-label">' + statusInfo.label + '</span></div>' +
      (t.goal_money > 0 ? '<div style="margin-top:4px;"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;"><span style="font-size:10px;color:var(--text-muted);">Meta: ' + fmtMoney(t.goal_money) + '</span><span style="font-size:10px;font-weight:700;color:var(--money);">' + goalPct + '%</span></div><div style="width:100%;height:6px;background:var(--border);border-radius:3px;overflow:hidden;"><div style="height:100%;background:var(--money);border-radius:3px;width:' + goalPct + '%;"></div></div></div>' : '') +
      '</div>' +
      '<div class="ranking-stats">' +
      '<div class="ranking-ups">' + t.totalUps + ' UPS</div>' +
      (t.totalMoney ? '<div class="ranking-money">' + fmtMoney(t.totalMoney) + '</div>' : '') +
      '<div class="ranking-count">' + t.count + ' servi\u00E7o' + (t.count !== 1 ? 's' : '') + '</div>' +
      '</div>' +
      '</div>';
    var srvHtml = '<div id="' + accId + '" style="display:none;">';
    if (t.services && t.services.length) {
      srvHtml += '<div class="table-wrap"><table><thead><tr><th>Data</th><th>Serviço</th><th class="num">Qtd</th><th class="num">UPS</th><th class="num">R$</th><th class="num">Nota</th></tr></thead><tbody>';
      for (var j = 0; j < t.services.length; j++) {
        var s = t.services[j];
        srvHtml += '<tr>' +
          '<td class="date" style="white-space:nowrap;">' + formatDateBr(s.date) + '</td>' +
          '<td>' + escapeHtml(s.serviceName) + '</td>' +
          '<td class="num">' + s.quantity + '</td>' +
          '<td class="num" style="font-weight:700;color:var(--primary);">' + fmtUps(s.upsValue) + '</td>' +
          '<td class="num" style="font-weight:600;color:var(--money);">' + (s.totalMoney ? fmtMoney(s.totalMoney) : '-') + '</td>' +
          '<td class="num">' + (s.grade || '-') + '</td>' +
          '</tr>';
      }
      srvHtml += '</tbody></table></div>';
    } else {
      srvHtml += '<div class="empty-state"><p>Nenhum servi\u00E7o no per\u00EDodo</p></div>';
    }
    srvHtml += '</div>';
    html += srvHtml + '</div>';
  }
  container.innerHTML = html;
}

function toggleMonitorTeam(accId) {
  var el = $(accId);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function exportMonitorData() {
  var range = getMonitorRange();
  if (!range.start || !range.end) { toast('Selecione o período', 'error'); return; }
  loading(true);
  getMonitorTeamUsers().then(function(teams) {
    return buildCsvReport(teams, range.start, range.end);
  }).then(function(filtered) {
    loading(false);
    if (!filtered || filtered.length === 0) { toast('Nenhum dado para exportar no período', 'info'); return; }
    downloadCsv(filtered, 'exportacao_ups_' + range.start + '_to_' + range.end + '.csv');
  }).catch(function(err) {
    loading(false);
    toast('Erro ao exportar: ' + err.message, 'error');
  });
}

// ===== ADMIN: USUÁRIOS E SUPERVISORES =====
function populateSupervisorSelect(selectId, selectedId) {
  var sel = $(selectId);
  if (!sel) return;
  var supervisors = userCache.filter(function(u) { return u.role === 'supervisor'; });
  var current = selectedId || sel.value || '';
  sel.innerHTML = '<option value="">— Sem supervisor —</option>';
  supervisors.forEach(function(s) {
    var selAttr = (s.id === current) ? ' selected' : '';
    sel.innerHTML += '<option value="' + s.id + '"' + selAttr + '>' + escapeHtml(s.username) + '</option>';
  });
  sel.value = current;
}

function getCheckedTeams(containerId) {
  var container = $(containerId);
  var ids = [];
  if (!container) return ids;
  var boxes = container.querySelectorAll('input[type="checkbox"]:checked');
  for (var i = 0; i < boxes.length; i++) ids.push(boxes[i].value);
  return ids;
}

function populateTeamChecklist(containerId, selectedMap) {
  var container = $(containerId);
  if (!container) return;
  var teams = userCache.filter(function(u) { return u.role === 'equipe'; });
  if (!teams.length) {
    container.innerHTML = '<div class="empty-state" style="padding:8px;">Nenhuma equipe cadastrada</div>';
    return;
  }
  var html = '';
  teams.forEach(function(t) {
    var checked = selectedMap && selectedMap[t.id] ? ' checked' : '';
    var boxId = containerId + '_' + t.id;
    html += '<div class="activity-item"><input type="checkbox" value="' + t.id + '" id="' + boxId + '"' + checked + '>' +
      '<label for="' + boxId + '" style="font-size:12px;cursor:pointer;">' + escapeHtml(t.username) + '</label></div>';
  });
  container.innerHTML = html;
}

function populateAdminForms() {
  fbCached('users', CACHE_TTL).then(function(users) {
    userCache = toArray(users);
    populateSupervisorSelect('newTeamSupervisor', '');
    populateTeamChecklist('newUserTeams', null);
  }).catch(function() {});
}

// Vincula/desvincula uma equipe a uma conta de supervisor (em ambos os sentidos).
// Su-pervisores atualizam também o campo supervisor_id/supervisor da equipe;
// usuários visualizadores só recebem a permissão de visualização.
function linkTeamToSupervisor(supId, teamId, link) {
  if (!supId) return Promise.resolve();
  return fbOnce('users/' + supId).then(function(sup) {
    if (!sup) return;
    var name = sup.username || supId;
    var auth = sup.authorized_teams || {};
    if (link) {
      auth[teamId] = true;
    } else {
      delete auth[teamId];
    }
    var ops = [fbUpdate('users/' + supId, { authorized_teams: auth })];
    if (sup.role === 'supervisor') {
      if (link) {
        ops.push(fbUpdate('users/' + teamId, { supervisor_id: supId, supervisor: name }));
      } else {
        ops.push(fbOnce('users/' + teamId).then(function(team) {
          if (team && team.supervisor_id === supId) {
            return fbUpdate('users/' + teamId, { supervisor_id: '', supervisor: '' });
          }
        }));
      }
    }
    return Promise.all(ops);
  });
}

function createUser() {
  if (!ensureAdmin()) return;
  var name = $('newUserName').value.trim();
  var pass = $('newUserPass').value.trim();
  var role = $('newUserRole').value;
  if (!name || !pass) { showMsg('userFormMsg', 'error', 'Preencha nome de usuário e senha'); return; }
  clearMsg('userFormMsg');
  var teamIds = getCheckedTeams('newUserTeams');
  loading(true);
  fbOnce('users').then(function(users) {
    var arr = toArray(users);
    var exists = arr.some(function(u) { return u.username === name; });
    if (exists) {
      loading(false);
      showMsg('userFormMsg', 'error', 'Nome de usuário já existe');
      return;
    }
    var userData = {
      username: name, password: pass, role: role,
      authorized_teams: {},
      created_at: nowTimestamp(),
      created_by: currentUser ? currentUser.id : ''
    };
    teamIds.forEach(function(tid) { userData.authorized_teams[tid] = true; });
    return fbPush('users', userData).then(function(key) {
      var chain = Promise.resolve();
      teamIds.forEach(function(tid) {
        chain = chain.then(function() { return linkTeamToSupervisor(key, tid, true); });
      });
      return chain;
    });
  }).then(function() {
    loading(false);
    $('newUserName').value = '';
    $('newUserPass').value = '';
    toast('Usuário cadastrado com sucesso!', 'success');
    clearCachedReads();
    loadAllAdminData();
    loadUsersList();
  }).catch(function(err) {
    loading(false);
    showMsg('userFormMsg', 'error', 'Erro: ' + err.message);
  });
}

function loadUsersList() {
  fbCached('users', CACHE_TTL).then(function(users) {
    renderUsersList(toArray(users));
  });
}

function renderUsersList(users) {
  var container = $('usersList');
  if (!container) return;
  var managers = users.filter(function(u) { return u.role === 'supervisor' || u.role === 'user'; });
  if (managers.length === 0) {
    container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">manage_accounts</span><p>Nenhum usuário ou supervisor cadastrado</p></div>';
    return;
  }
  var teamsMap = {};
  users.forEach(function(t) { if (t.role === 'equipe') teamsMap[t.id] = t.username; });
  var isSup = isSupervisor();
  var html = '<div class="table-wrap"><table><thead><tr><th>Usuário</th><th>Perfil</th><th>Equipes vinculadas</th>' + (isSup ? '' : '<th>Ações</th>') + '</tr></thead><tbody>';
  for (var i = 0; i < managers.length; i++) {
    var u = managers[i];
    var links = [];
    var auth = u.authorized_teams || {};
    Object.keys(auth).forEach(function(tid) {
      if (auth[tid] && teamsMap[tid]) links.push('<span class="tag tag-active">' + escapeHtml(teamsMap[tid]) + '</span>');
    });
    var band = links.length ? links.join(' ') : '<span style="color:var(--text-muted);">Nenhuma equipe</span>';
    html += '<tr>' +
      '<td><strong>' + escapeHtml(u.username) + '</strong></td>' +
      '<td><span class="tag ' + (u.role === 'supervisor' ? 'tag-active' : 'tag-inactive') + '">' + roleLabel(u.role) + '</span></td>' +
      '<td>' + band + '</td>' +
      (isSup ? '' : '<td class="actions">' +
      '<button class="btn btn-sm btn-outline" onclick="editUser(\'' + u.id + '\')"><span class="material-symbols-outlined">edit</span> Editar</button>' +
      '<button class="btn btn-sm btn-danger" onclick="deleteUser(\'' + u.id + '\')"><span class="material-symbols-outlined">delete</span></button>' +
      '</td>') +
      '</tr>';
  }
  html += '</tbody></table></div>';
  container.innerHTML = html;
}

function editUser(id) {
  loading(true);
  fbOnce('users/' + id).then(function(user) {
    loading(false);
    if (!user) { toast('Usuário não encontrado', 'error'); return; }
    $('editUserId').value = id;
    $('editUserName').value = user.username || '';
    $('editUserRole').value = (user.role === 'user') ? 'user' : 'supervisor';
    $('editUserPass').value = '';
    populateTeamChecklist('editUserTeams', user.authorized_teams || {});
    clearMsg('editUserMsg');
    $('editUserModal').style.display = 'flex';
  }).catch(function(err) {
    loading(false);
    toast('Erro: ' + err.message, 'error');
  });
}

function saveEditUser() {
  if (!ensureAdmin()) return;
  var id = $('editUserId').value;
  var name = $('editUserName').value.trim();
  var role = $('editUserRole').value;
  var pass = $('editUserPass').value.trim();
  if (!name) { showMsg('editUserMsg', 'error', 'O nome de usuário é obrigatório'); return; }
  clearMsg('editUserMsg');
  var teamIds = getCheckedTeams('editUserTeams');
  loading(true);
  fbOnce('users/' + id).then(function(user) {
    var prevMap = (user && user.authorized_teams) || {};
    var updateData = { username: name, role: role };
    if (pass && pass.length >= 3) updateData.password = pass;
    var auth = {};
    teamIds.forEach(function(tid) { auth[tid] = true; });
    updateData.authorized_teams = auth;
    return fbUpdate('users/' + id, updateData).then(function() {
      var added = teamIds.filter(function(tid) { return !prevMap[tid]; });
      var removed = Object.keys(prevMap).filter(function(tid) { return teamIds.indexOf(tid) === -1; });
      var chain = Promise.resolve();
      added.forEach(function(tid) { chain = chain.then(function() { return linkTeamToSupervisor(id, tid, true); }); });
      removed.forEach(function(tid) { chain = chain.then(function() { return linkTeamToSupervisor(id, tid, false); }); });
      return chain;
    });
  }).then(function() {
    loading(false);
    toast('Usuário atualizado com sucesso!', 'success');
    closeEditUserModal();
    clearCachedReads();
    loadAllAdminData();
    loadUsersList();
  }).catch(function(err) {
    loading(false);
    showMsg('editUserMsg', 'error', 'Erro: ' + err.message);
  });
}

function deleteUser(id) {
  if (!ensureAdmin()) return;
  if (!confirm('Excluir este usuário? As equipes vinculadas deixarão de ser visíveis para ele.')) return;
  loading(true);
  fbOnce('users/' + id).then(function(user) {
    var auth = (user && user.authorized_teams) || {};
    var teamIds = Object.keys(auth).filter(function(k) { return auth[k]; });
    var chain = Promise.resolve();
    teamIds.forEach(function(tid) {
      chain = chain.then(function() { return linkTeamToSupervisor(id, tid, false); });
    });
    return chain.then(function() { return fbRemove('users/' + id); });
  }).then(function() {
    loading(false);
    toast('Usuário excluído', 'info');
    clearCachedReads();
    loadAllAdminData();
    loadUsersList();
  }).catch(function(err) {
    loading(false);
    toast('Erro: ' + err.message, 'error');
  });
}

function closeEditUserModal() {
  $('editUserModal').style.display = 'none';
}

function cleanupLocationHistory() {
  if (!ensureAdmin()) return;
  if (!confirm('Remover histórico de localização com mais de 30 dias? Isso libera espaço no banco e no dispositivo.')) return;
  loading(true);
  OfflineDB.pruneLocationHistory(30).then(function(res) {
    loading(false);
    toast('Localização antiga removida (' + ((res && res.removed) || 0) + ' registros).', 'success');
    updateSyncStatus();
  }).catch(function(err) {
    loading(false);
    toast('Erro: ' + err.message, 'error');
  });
}

function cleanupLocalRetention() {
  if (!ensureAdmin()) return;
  loading(true);
  OfflineDB.prune({ servicesDays: 365, locationDays: 30 }).then(function() {
    loading(false);
    toast('Retenção local aplicada: serviços > 365 dias e localização > 30 dias removidos.', 'success');
  }).catch(function(err) {
    loading(false);
    toast('Erro: ' + err.message, 'error');
  });
}

function refreshCachedData() {
  if (!ensureAdmin()) return;
  clearCachedReads();
  toast('Cache de leitura invalidado. Próxima atualização busca dados novos.', 'info');
  loadAllAdminData();
}

// ===== ADMIN VIEW =====
function applyDateRangeTo(id) {
  var el = $(id);
  if (!el) return;
  var range = getAllowedDateRange();
  if (range) {
    el.min = range.start;
    el.max = range.end;
  } else {
    el.removeAttribute('min');
    el.removeAttribute('max');
  }
}

// Aplica restrições visuais/de período para supervisor (somente visualização,
// dados das próprias equipes e últimos 3 dias).
function applyAdminRestrictions() {
  var isSup = isSupervisor();

  ['adminStartDate', 'adminEndDate', 'auditoriaStartDate', 'auditoriaEndDate',
   'classificacaoStartDate', 'classificacaoEndDate', 'apontamentoStartDate', 'apontamentoEndDate']
    .forEach(applyDateRangeTo);

  [['newTeamCard', isSup], ['newUserCard', isSup], ['maintenanceCard', isSup],
   ['newCatalogCard', isSup], ['rulesAddActions', isSup], ['rulesSaveBtn', isSup]]
    .forEach(function(pair) {
      var el = $(pair[0]);
      if (el) el.style.display = pair[1] ? 'none' : '';
    });
}

function initAdminView() {
  var today = todayStr();
  var isSup = isSupervisor();
  $('adminStartDate').value = clampDateToAllowed(today);
  $('adminEndDate').value = clampDateToAllowed(today);
  $('adminDate').textContent = formatDateBr(today);
  applyAdminRestrictions();
  showView('adminView');
  initTabs();
  loadAllAdminData();
  populateAdminForms();
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(loadAllAdminData, 30000);
  $('adminStartDate').addEventListener('change', loadAllAdminData);
  $('adminEndDate').addEventListener('change', loadAllAdminData);
  if (!isSup) setTimeout(captureAdminLocation, 500);
}

function initTabs() {
  var tabs = document.querySelectorAll('.nav-tab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].addEventListener('click', function() {
      var activeTab = document.querySelector('.nav-tab.active');
      if (activeTab) activeTab.classList.remove('active');
      this.classList.add('active');
      var activeContent = document.querySelector('.tab-content.active');
      if (activeContent) activeContent.classList.remove('active');
      var tabId = this.getAttribute('data-tab');
      $(tabId).classList.add('active');
      if (tabId === 'tabEquipes') {
        loadTeamsList();
        populateAdminForms();
      }
      if (tabId === 'tabUsuarios') {
        loadUsersList();
        populateAdminForms();
      }
      if (tabId === 'tabServicos') {
        loadCatalogList();
      }
      if (tabId === 'tabMapa') {
        setTimeout(initMap, 100);
      }
      if (tabId === 'tabEstatisticas') {
        loadStatistics();
      }
      if (tabId === 'tabRegras') {
        loadRules();
      }
      if (tabId === 'tabSupervisores') {
        loadSupervisores();
      }
      if (tabId === 'tabAuditoria') {
        initAuditoria();
      }
      if (tabId === 'tabClassificacao') {
        initClassificacao();
      }
      if (tabId === 'tabApontamento') {
        initApontamento();
      }
    });
  }
}

function loadAllAdminData() {
  var start = clampDateToAllowed($('adminStartDate').value);
  var end = clampDateToAllowed($('adminEndDate').value);
  $('adminStartDate').value = start;
  $('adminEndDate').value = end;
  fbCached('rules', CACHE_TTL).then(function(rules) {
    rulesCache = toArray(rules).map(function(r) {
      return { id: r.id, class: r.class, minUps: r.min_ups, maxUps: r.max_ups, color: r.color };
    });
    loadPainel(start, end);
  });
  fbCached('users', CACHE_TTL).then(function(users) {
    userCache = toArray(users);
    syncCurrentUserAutorizations();
  });
  loadTeamsList();
  loadCatalogList();
  loadMapData(start, end);
  loadStatistics();
}

// Mantém as autorizações do supervisor atualizadas em tempo real (equipes
// vinculadas pelo admin sem precisar reentrar).
function syncCurrentUserAutorizations() {
  if (!currentUser || currentUser.role !== 'supervisor') return;
  if (!userCache || !userCache.length) return;
  var self = userCache.find(function(u) { return u.id === currentUser.id; });
  if (self) {
    currentUser.authorized_teams = self.authorized_teams || {};
  }
}

// --- Painel ---
function loadPainel(start, end) {
  getAllTeamsSummaryForPeriod(start, end).then(function(data) {
    renderPainel(data);
  }).catch(function(err) {
    console.error('Erro ao carregar painel:', err);
  });
}

function getStatusInfo(lastSeen) {
  if (!lastSeen) return { status: 'offline', label: 'Offline', className: 'status-offline' };
  var now = Date.now();
  var diffMin = (now - lastSeen) / 60000;
  if (diffMin < 5) return { status: 'online', label: 'Online', className: 'status-online' };
  var d = new Date(lastSeen);
  var timeStr = d.toLocaleString('pt-BR');
  return { status: 'offline', label: 'Visto: ' + timeStr, className: 'status-offline' };
}

function renderPainel(data) {
  var container = $('adminPainelContent');
  if (!data || data.length === 0) {
    container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">groups</span><p>Nenhuma equipe cadastrada</p></div>';
    return;
  }
  var totalUpsAll = data.reduce(function(s, t) { return s + t.totalUps; }, 0);
  var totalMoneyAll = data.reduce(function(s, t) { return s + t.totalMoney; }, 0);
  var totalServicesAll = data.reduce(function(s, t) { return s + t.count; }, 0);
  var teamsOnline = data.filter(function(t) { return getStatusInfo(t.lastSeen).status === 'online'; }).length;
  var grades = [];
  data.forEach(function(t) {
    t.services.forEach(function(s) { if (s.grade > 0) grades.push(s.grade); });
  });
  var totalGradeCount = grades.length;

  var sorted = data.slice().sort(function(a, b) { return b.totalUps - a.totalUps; });

  var html = '<div class="stats-overview">' +
    '<div class="stat-box"><span class="stat-box-icon teams"><span class="material-symbols-outlined">groups</span></span><div><div class="stat-box-value">' + data.length + '</div><div class="stat-box-label">Equipes</div></div></div>' +
    '<div class="stat-box"><span class="stat-box-icon online"><span class="material-symbols-outlined">wifi</span></span><div><div class="stat-box-value">' + teamsOnline + '</div><div class="stat-box-label">Online</div></div></div>' +
    '<div class="stat-box"><span class="stat-box-icon ups"><span class="material-symbols-outlined">trending_up</span></span><div><div class="stat-box-value">' + totalUpsAll + '</div><div class="stat-box-label">Total UPS</div></div></div>' +
    '<div class="stat-box"><span class="stat-box-icon money"><span class="material-symbols-outlined">payments</span></span><div><div class="stat-box-value">' + fmtMoney(totalMoneyAll) + '</div><div class="stat-box-label">Total R$</div></div></div>' +
    '<div class="stat-box"><span class="stat-box-icon services"><span class="material-symbols-outlined">assignment</span></span><div><div class="stat-box-value">' + totalServicesAll + '</div><div class="stat-box-label">Serviços</div></div></div>' +
    '<div class="stat-box"><span class="stat-box-icon grade"><span class="material-symbols-outlined">star</span></span><div><div class="stat-box-value">' + totalGradeCount + '</div><div class="stat-box-label">Total Notas</div></div></div>' +
    '</div>';

  html += '<div style="margin:16px 0 8px;font-size:13px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;">Ranking de Equipes</div>';
  html += '<div class="ranking-list">';
  for (var i = 0; i < sorted.length; i++) {
    var t = sorted[i];
    var medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '#' + (i + 1);
    var color = t.color || '#94a3b8';
    var statusInfo = getStatusInfo(t.lastSeen);
    var barWidth = t.totalUps > 0 ? Math.max(4, (t.totalUps / sorted[0].totalUps) * 100) : 0;
    var teamGrades = t.services.filter(function(s) { return s.grade > 0; }).map(function(s) { return s.grade; });
    var teamTotalGradeCount = teamGrades.length;

    html += '<div class="ranking-item" onclick="openTeamModal(\'' + t.userId + '\')">' +
      '<div class="ranking-pos">' + medal + '</div>' +
      '<div class="badge badge-sm" style="background:' + color + ';">' + t.class + '</div>' +
      '<div class="ranking-info">' +
      '<div class="ranking-name">' + escapeHtml(t.username) + (t.supervisor ? ' <span style="font-size:11px;color:var(--text-muted);font-weight:400;">(' + escapeHtml(t.supervisor) + ')</span>' : '') + '</div>' +
      '<div class="ranking-status ' + statusInfo.className + '"><span class="status-dot"></span><span class="status-label">' + statusInfo.label + '</span></div>' +
      (t.goal_money > 0 ? '<div style="margin-top:4px;"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;"><span style="font-size:10px;color:var(--text-muted);">Meta: ' + fmtMoney(t.goal_money) + '</span><span style="font-size:10px;font-weight:700;color:var(--money);">' + Math.min(100, Math.round((t.totalMoney / t.goal_money) * 100)) + '%</span></div><div style="width:100%;height:6px;background:var(--border);border-radius:3px;overflow:hidden;"><div style="height:100%;background:var(--money);border-radius:3px;width:' + Math.min(100, (t.totalMoney / t.goal_money) * 100) + '%;"></div></div></div>' : '') +
      shiftMiniBar(t) +
      '</div>' +
      '<div class="ranking-stats">' +
      '<div class="ranking-ups">' + t.totalUps + ' UPS</div>' +
      (t.totalMoney ? '<div class="ranking-money">' + fmtMoney(t.totalMoney) + '</div>' : '') +
      '<div class="ranking-count">' + t.count + ' servi\u00E7o' + (t.count !== 1 ? 's' : '') + '</div>' +
      (teamTotalGradeCount > 0 ? '<div class="ranking-grade">Notas: ' + teamTotalGradeCount + '</div>' : '') +
      '</div>' +
      '<div class="ranking-bar"><div class="ranking-bar-fill" style="width:' + barWidth + '%;background:' + color + ';"></div></div>' +
      '</div>';
  }
  html += '</div>';
  container.innerHTML = html;
}

// --- Equipes ---
function loadTeamsList() {
  fbCached('users', CACHE_TTL).then(function(users) {
    userCache = toArray(users);
    renderTeamsList(userCache);
  });
}

function renderTeamsList(users) {
  var container = $('teamsList');
  var isSup = isSupervisor();
  var teams = users.filter(function(u) { return u.role !== 'admin' && canViewTeam(u.id); });
  if (teams.length === 0) {
    container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">groups</span><p>' +
      (isSup ? 'Nenhuma equipe vinculada à sua conta' : 'Nenhuma equipe cadastrada') + '</p></div>';
    return;
  }
  var dayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  var html = '<div class="table-wrap"><table><thead><tr><th>ID</th><th>Nome</th><th>Supervisor</th><th>Meta R$</th><th>Status</th><th>Função</th><th>Turno</th><th>Dias</th><th>Localização</th>' + (isSup ? '' : '<th>Ações</th>') + '</tr></thead><tbody>';
  for (var i = 0; i < teams.length; i++) {
    var t = teams[i];
    var statusInfo = getStatusInfo(t.last_seen);
    var statusHtml = '<span class="' + statusInfo.className + '"><span class="status-dot"></span><span class="status-label">' + statusInfo.label + '</span></span>';
    var locDisplay = '';
    if (t.latitude && t.longitude) {
      locDisplay = '<span style="font-size:11px;color:var(--text-muted);">' +
        parseFloat(t.latitude).toFixed(4) + ', ' + parseFloat(t.longitude).toFixed(4) + '</span>';
    } else {
      locDisplay = '<span style="font-size:11px;color:var(--text-muted);">—</span>';
    }
    var goalDisplay = t.goal_money > 0 ? fmtMoney(t.goal_money) : '<span style="color:var(--text-muted);">—</span>';
    var supDisplay = t.supervisor ? escapeHtml(t.supervisor) : '<span style="color:var(--text-muted);">—</span>';
    var shiftDisplay = '<span style="color:var(--text-muted);">—</span>';
    var shiftStatus = '';
    var shiftSp = getShiftProgress(t);
    if (shiftSp.enabled) {
      var sColor = shiftColor(shiftSp);
      shiftDisplay = '<span style="font-size:12px;font-weight:600;">' + shiftSp.start + ' – ' + shiftSp.end + '</span>';
      shiftStatus = '<span style="display:inline-block;margin-top:2px;font-size:10px;font-weight:700;color:' + sColor + ';">' + shiftSp.label + '</span>';
    }
    var daysDisplay = '<span style="color:var(--text-muted);">—</span>';
    if (t.days_of_week && t.days_of_week.length > 0) {
      daysDisplay = t.days_of_week.map(function(d) {
        return '<span style="display:inline-block;padding:1px 5px;margin:1px;font-size:10px;font-weight:600;background:var(--primary-bg);color:var(--primary);border-radius:4px;">' + dayNames[d] + '</span>';
      }).join('');
    }
    html += '<tr>' +
      '<td style="font-weight:600;color:var(--text-muted);">#' + t.id.slice(-6) + '</td>' +
      '<td><strong>' + escapeHtml(t.username) + '</strong></td>' +
      '<td>' + supDisplay + '</td>' +
      '<td style="color:var(--money);font-weight:600;">' + goalDisplay + '</td>' +
      '<td>' + statusHtml + '</td>' +
      '<td><span style="background:var(--primary-bg);color:var(--primary);padding:2px 10px;border-radius:20px;font-size:12px;font-weight:600;">' + t.role + '</span></td>' +
      '<td>' + shiftDisplay + shiftStatus + '</td>' +
      '<td>' + daysDisplay + '</td>' +
      '<td>' + locDisplay + '</td>' +
      (isSup ? '' : '<td class="actions">' +
      '<button class="btn btn-sm btn-outline" onclick="editTeam(\'' + t.id + '\')"><span class="material-symbols-outlined">edit</span> Editar</button>' +
      '<button class="btn btn-sm btn-danger" onclick="deleteTeam(\'' + t.id + '\')"><span class="material-symbols-outlined">delete</span></button>' +
      '</td>') +
      '</tr>';
  }
  html += '</tbody></table></div>';
  container.innerHTML = html;
}

function captureLocationForTeam() {
  captureAdminLocation();
}

function getSelectedDaysOfWeek() {
  var days = [];
  var checkboxes = document.querySelectorAll('#newTeamDays input[name="teamDay"]:checked');
  for (var i = 0; i < checkboxes.length; i++) {
    days.push(parseInt(checkboxes[i].value));
  }
  return days;
}

function setSelectedDaysOfWeek(days) {
  var checkboxes = document.querySelectorAll('#editTeamDays input[name="editTeamDay"]');
  for (var i = 0; i < checkboxes.length; i++) {
    checkboxes[i].checked = days && days.indexOf(parseInt(checkboxes[i].value)) !== -1;
  }
}

function createTeam() {
  if (!ensureAdmin()) return;
  var name = $('newTeamName').value.trim();
  var pass = $('newTeamPass').value.trim();
  var supId = $('newTeamSupervisor').value;
  var goalRaw = $('newTeamGoal').value;
  var goalMoney = parseFloat(goalRaw) || 0;
  var shiftStart = $('newTeamShiftStart').value;
  var shiftEnd = $('newTeamShiftEnd').value;
  var daysOfWeek = getSelectedDaysOfWeek();
  if (!name || !pass) { showMsg('teamFormMsgAdmin', 'error', 'Preencha nome e senha da equipe'); return; }
  clearMsg('teamFormMsgAdmin');

  if (!adminLocation) {
    showMsg('teamFormMsgAdmin', 'warning', 'Capturando localização... Clique novamente para criar com localização automática, ou clique em "Detectar" primeiro.');
    captureAdminLocation();
    return;
  }

  loading(true);
  fbOnce('users').then(function(users) {
    var arr = toArray(users);
    var exists = arr.some(function(u) { return u.username === name; });
    if (exists) {
      loading(false);
      showMsg('teamFormMsgAdmin', 'error', 'Nome de usuário já existe');
      return;
    }
    var supUser = supId ? arr.find(function(u) { return u.id === supId; }) : null;
    var userData = {
      username: name, password: pass, role: 'equipe',
      supervisor_id: supUser ? supId : '',
      supervisor: supUser ? supUser.username : '',
      goal_money: goalMoney,
      shift_start: shiftStart || '',
      shift_end: shiftEnd || '',
      days_of_week: daysOfWeek,
      latitude: String(adminLocation.lat),
      longitude: String(adminLocation.lng),
      address: adminAddress || '',
      last_seen: nowTimestamp(),
      created_at: nowTimestamp(),
      registered_by: currentUser ? currentUser.id : '',
      registered_at: nowTimestamp()
    };
    return fbPush('users', userData).then(function(key) {
      var linkChain = supUser
        ? linkTeamToSupervisor(supId, key, true)
        : Promise.resolve();
      return linkChain.then(function() { return key; });
    }).then(function(key) {
      loading(false);
      $('newTeamName').value = '';
      $('newTeamPass').value = '';
      $('newTeamSupervisor').value = '';
      $('newTeamGoal').value = '';
      $('newTeamShiftStart').value = '';
      $('newTeamShiftEnd').value = '';
      var dayCheckboxes = document.querySelectorAll('#newTeamDays input[name="teamDay"]');
      for (var d = 0; d < dayCheckboxes.length; d++) { dayCheckboxes[d].checked = false; }
      toast('Equipe criada com sucesso!', 'success');
      loadAllAdminData();
      adminLocation = null;
      adminAddress = '';
      var locText = $('locationText');
      var locIcon = $('locationIcon');
      if (locIcon) locIcon.textContent = 'my_location';
      if (locText) locText.textContent = 'Pronto para capturar localização da próxima equipe';
      captureAdminLocation();
    });
  }).catch(function(err) {
    loading(false);
    showMsg('teamFormMsgAdmin', 'error', 'Erro: ' + err.message);
  });
}

function deleteTeam(id) {
  if (!ensureAdmin()) return;
  if (!confirm('Excluir esta equipe?')) return;
  loading(true);
  fbOnce('users/' + id).then(function(user) {
    var supId = user && user.supervisor_id;
    var unlink = supId ? linkTeamToSupervisor(supId, id, false) : Promise.resolve();
    return unlink.then(function() {
      return fbRemove('users/' + id);
    });
  }).then(function() {
    loading(false);
    toast('Equipe excluída', 'info');
    loadAllAdminData();
  }).catch(function(err) {
    loading(false);
    toast('Erro: ' + err.message, 'error');
  });
}

function showResetPass(id) {
  if (!ensureAdmin()) return;
  var newPass = prompt('Nova senha para a equipe:');
  if (!newPass || newPass.length < 3) return;
  loading(true);
  fbUpdate('users/' + id, { password: newPass }).then(function() {
    loading(false);
    toast('Senha redefinida!', 'success');
    loadAllAdminData();
  }).catch(function(err) {
    loading(false);
    toast('Erro: ' + err.message, 'error');
  });
}

function editTeam(id) {
  loading(true);
  fbOnce('users/' + id).then(function(user) {
    loading(false);
    if (!user) { toast('Equipe não encontrada', 'error'); return; }
    $('editTeamId').value = id;
    $('editTeamName').value = user.username || '';
    var supSel = $('editTeamSupervisor');
    if (!supSel.options.length) populateSupervisorSelect('editTeamSupervisor', '');
    supSel.value = user.supervisor_id || '';
    $('editTeamGoal').value = user.goal_money > 0 ? user.goal_money : '';
    $('editTeamShiftStart').value = user.shift_start || '';
    $('editTeamShiftEnd').value = user.shift_end || '';
    setSelectedDaysOfWeek(user.days_of_week || []);
    $('editTeamPass').value = '';
    clearMsg('editTeamMsg');
    $('editTeamModal').style.display = 'flex';
  }).catch(function(err) {
    loading(false);
    toast('Erro: ' + err.message, 'error');
  });
}

function saveEditTeam() {
  if (!ensureAdmin()) return;
  var id = $('editTeamId').value;
  var name = $('editTeamName').value.trim();
  var supId = $('editTeamSupervisor').value;
  var goalRaw = $('editTeamGoal').value;
  var goalMoney = parseFloat(goalRaw) || 0;
  var shiftStart = $('editTeamShiftStart').value;
  var shiftEnd = $('editTeamShiftEnd').value;
  var newPass = $('editTeamPass').value.trim();
  var editCheckboxes = document.querySelectorAll('#editTeamDays input[name="editTeamDay"]');
  var editDays = [];
  for (var i = 0; i < editCheckboxes.length; i++) {
    if (editCheckboxes[i].checked) editDays.push(parseInt(editCheckboxes[i].value));
  }

  if (!name) { showMsg('editTeamMsg', 'error', 'O nome da equipe é obrigatório'); return; }
  clearMsg('editTeamMsg');

  loading(true);
  fbOnce('users/' + id).then(function(team) {
    var oldSupId = team && team.supervisor_id;
    var supUser = null;
    var ops = [];
    if (supId) {
      return fbOnce('users/' + supId).then(function(sup) {
        supUser = sup;
        var updateData = {
          username: name,
          supervisor_id: supUser ? supId : '',
          supervisor: supUser ? supUser.username || '' : '',
          goal_money: goalMoney,
          shift_start: shiftStart || '',
          shift_end: shiftEnd || '',
          days_of_week: editDays
        };
        if (newPass && newPass.length >= 3) updateData.password = newPass;
        ops.push(fbUpdate('users/' + id, updateData));
        if (supUser && supUser.role === 'supervisor') ops.push(linkTeamToSupervisor(supId, id, true));
        if (oldSupId && oldSupId !== supId) ops.push(linkTeamToSupervisor(oldSupId, id, false));
        return Promise.all(ops);
      });
    }
    var updateData = {
      username: name,
      supervisor_id: '',
      supervisor: '',
      goal_money: goalMoney,
      shift_start: shiftStart || '',
      shift_end: shiftEnd || '',
      days_of_week: editDays
    };
    if (newPass && newPass.length >= 3) updateData.password = newPass;
    ops.push(fbUpdate('users/' + id, updateData));
    if (oldSupId) ops.push(linkTeamToSupervisor(oldSupId, id, false));
    return Promise.all(ops);
  }).then(function() {
    loading(false);
    toast('Equipe atualizada com sucesso!', 'success');
    closeEditTeamModal();
    loadAllAdminData();
  }).catch(function(err) {
    loading(false);
    showMsg('editTeamMsg', 'error', 'Erro: ' + err.message);
  });
}

function closeEditTeamModal() {
  $('editTeamModal').style.display = 'none';
}

// --- Catálogo de Serviços ---
function loadCatalogList() {
  fbCached('catalog_services', 60000).then(function(services) {
    renderCatalogList(toArray(services));
  });
}

function renderCatalogList(services) {
  var container = $('catalogList');
  if (!services || services.length === 0) {
    container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">build</span><p>Nenhum serviço cadastrado</p></div>';
    return;
  }
  var html = '<div class="service-card-grid">';
  for (var i = 0; i < services.length; i++) {
    var s = services[i];
    var activeTag = s.active
      ? '<span class="tag tag-active">Ativo</span>'
      : '<span class="tag tag-inactive">Inativo</span>';
    var editId = 'catalogEdit_' + s.id;
    html += '<div class="service-card-item" id="' + editId + '_card">' +
      '<div class="sc-icon"><span class="material-symbols-outlined">build</span></div>' +
      '<div class="sc-body">' +
      '<div class="sc-name">' + escapeHtml(s.name) + ' ' + activeTag + '</div>' +
      '<div class="sc-detail">' + s.ups_value + ' UPS / un  |  ' + fmtMoney(s.money_value) + ' / un</div>' +
      '</div>' +
      '<div class="sc-actions">' +
      '<button class="btn btn-sm btn-outline" onclick="toggleEditCatalog(\'' + s.id + '\')"><span class="material-symbols-outlined">edit</span></button>' +
      '<button class="btn btn-sm btn-danger" onclick="deleteCatalogService(\'' + s.id + '\')"><span class="material-symbols-outlined">delete</span></button>' +
      '</div></div>' +
      '<div class="card" id="' + editId + '" style="display:none;margin-top:-6px;">' +
      '<div class="form-row">' +
      '<div class="form-group"><label>Nome</label><input type="text" id="' + editId + '_name" value="' + escapeHtml(s.name) + '"></div>' +
      '<div class="form-group"><label>UPS/un</label><input type="number" id="' + editId + '_ups" value="' + s.ups_value + '" min="0" step="0.5"></div>' +
      '<div class="form-group"><label>R$/un</label><input type="number" id="' + editId + '_money" value="' + s.money_value + '" min="0" step="0.01"></div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;margin-top:8px;">' +
      '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;font-weight:500;">' +
      '<input type="checkbox" id="' + editId + '_active" ' + (s.active ? 'checked' : '') + '> Ativo</label>' +
      '<button class="btn btn-sm btn-success" onclick="saveCatalogEdit(\'' + s.id + '\')"><span class="material-symbols-outlined">check</span> Salvar</button>' +
      '<button class="btn btn-sm btn-ghost" onclick="toggleEditCatalog(\'' + s.id + '\')">Cancelar</button>' +
      '</div></div>';
  }
  html += '</div>';
  container.innerHTML = html;
}

function toggleEditCatalog(id) {
  var editDiv = $('catalogEdit_' + id);
  if (editDiv) editDiv.style.display = editDiv.style.display === 'none' ? 'block' : 'none';
}

function createCatalogService() {
  if (!ensureAdmin()) return;
  var name = $('catalogName').value.trim();
  var ups = parseFloat($('catalogUps').value);
  var money = parseFloat($('catalogMoney').value);
  if (!name) { showMsg('catalogFormMsg', 'error', 'Informe o nome do serviço'); return; }
  if (isNaN(ups) || ups < 0) { showMsg('catalogFormMsg', 'error', 'Valor UPS inválido'); return; }
  if (isNaN(money) || money < 0) { showMsg('catalogFormMsg', 'error', 'Valor em dinheiro inválido'); return; }
  clearMsg('catalogFormMsg');
  loading(true);
  var data = { name: name, ups_value: ups, money_value: money, active: true, created_at: nowTimestamp() };
  fbPush('catalog_services', data).then(function() {
    loading(false);
    $('catalogName').value = '';
    $('catalogUps').value = '';
    $('catalogMoney').value = '';
    toast('Serviço cadastrado!', 'success');
    loadCatalogList();
  }).catch(function(err) {
    loading(false);
    showMsg('catalogFormMsg', 'error', 'Erro: ' + err.message);
  });
}

function saveCatalogEdit(id) {
  if (!ensureAdmin()) return;
  var editId = 'catalogEdit_' + id;
  var name = $(editId + '_name').value.trim();
  var ups = parseFloat($(editId + '_ups').value);
  var money = parseFloat($(editId + '_money').value);
  var active = $(editId + '_active').checked;
  if (!name) { toast('Nome obrigatório', 'error'); return; }
  if (isNaN(ups) || ups < 0) { toast('Valor UPS inválido', 'error'); return; }
  if (isNaN(money) || money < 0) { toast('Valor em dinheiro inválido', 'error'); return; }
  loading(true);
  fbUpdate('catalog_services/' + id, { name: name, ups_value: ups, money_value: money, active: active }).then(function() {
    loading(false);
    toast('Serviço atualizado!', 'success');
    loadCatalogList();
  }).catch(function(err) {
    loading(false);
    toast('Erro: ' + err.message, 'error');
  });
}

function deleteCatalogService(id) {
  if (!ensureAdmin()) return;
  if (!confirm('Excluir este serviço do catálogo?')) return;
  loading(true);
  fbRemove('catalog_services/' + id).then(function() {
    loading(false);
    toast('Serviço excluído', 'info');
    loadCatalogList();
  }).catch(function(err) {
    loading(false);
    toast('Erro: ' + err.message, 'error');
  });
}

function exportData() {
  var start = clampDateToAllowed($('adminStartDate').value);
  var end = clampDateToAllowed($('adminEndDate').value);
  $('adminStartDate').value = start;
  $('adminEndDate').value = end;
  if (!start || !end) { toast('Selecione o período', 'error'); return; }
  loading(true);
  fbCached('users', CACHE_TTL).then(function(users) {
    var teams = toArray(users).filter(function(u) { return u.role !== 'admin' && canViewTeam(u.id); });
    return buildCsvReport(teams, start, end);
  }).then(function(filtered) {
    loading(false);
    if (!filtered || filtered.length === 0) { toast('Nenhum dado para exportar no período', 'info'); return; }
    downloadCsv(filtered, 'exportacao_ups_' + start + '_to_' + end + '.csv');
  }).catch(function(err) {
    loading(false);
    toast('Erro ao exportar: ' + err.message, 'error');
  });
}

// --- Apontamento de Turno ---
function defaultPeriodForInputs(startId, endId) {
  var range = getAllowedDateRange();
  if (range) {
    $(startId).value = range.end;
    $(endId).value = range.end;
    return;
  }
  var now = new Date();
  $(startId).value = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-01';
  $(endId).value = formatDate(new Date(now.getFullYear(), now.getMonth() + 1, 0));
}

function initApontamento() {
  if (!$('apontamentoStartDate').value) {
    defaultPeriodForInputs('apontamentoStartDate', 'apontamentoEndDate');
  }
}

function setApontamentoCurrentMonth() {
  defaultPeriodForInputs('apontamentoStartDate', 'apontamentoEndDate');
  loadApontamentos();
}

function loadApontamentos() {
  var start = clampDateToAllowed($('apontamentoStartDate').value);
  var end = clampDateToAllowed($('apontamentoEndDate').value);
  $('apontamentoStartDate').value = start;
  $('apontamentoEndDate').value = end;
  if (!start || !end) { toast('Selecione o período', 'error'); return; }
  loading(true);
  Promise.all([fbOnce('services'), fbOnce('users'), fbOnce('shift_notes')]).then(function(results) {
    var allServices = toArray(results[0]);
    var users = toArray(results[1]);
    var teams = users.filter(function(u) { return u.role !== 'admin' && canViewTeam(u.id); });
    var existingNotes = toArray(results[2]);
    var notesMap = {};
    existingNotes.forEach(function(n) { notesMap[n.team_id + '_' + n.date] = n; });
    var servicesByTeamDate = {};
    allServices.forEach(function(s) {
      var key = s.user_id + '_' + s.date;
      if (!servicesByTeamDate[key]) servicesByTeamDate[key] = [];
      servicesByTeamDate[key].push(s);
    });
    var missing = [];
    var dayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    var currentDate = new Date(start + 'T00:00:00');
    var endDate = new Date(end + 'T00:00:00');
    while (currentDate <= endDate) {
      var dateStr = currentDate.getFullYear() + '-' + String(currentDate.getMonth() + 1).padStart(2, '0') + '-' + String(currentDate.getDate()).padStart(2, '0');
      var dayOfWeek = currentDate.getDay();
      for (var i = 0; i < teams.length; i++) {
        var t = teams[i];
        var isScheduled = t.days_of_week && t.days_of_week.indexOf(dayOfWeek) !== -1;
        if (!isScheduled) continue;
        var key = t.id + '_' + dateStr;
        var dayServices = servicesByTeamDate[key] || [];
        if (dayServices.length === 0) {
          var noteKey = t.id + '_' + dateStr;
          var existing = notesMap[noteKey];
          missing.push({
            team_id: t.id,
            team_name: t.username,
            date: dateStr,
            day_name: dayNames[dayOfWeek],
            note_id: existing ? existing.id : null,
            reason: existing ? existing.reason : ''
          });
        }
      }
      currentDate.setDate(currentDate.getDate() + 1);
    }
    loading(false);
    renderApontamentos(missing);
  }).catch(function(err) {
    loading(false);
    toast('Erro ao carregar apontamentos: ' + err.message, 'error');
  });
}

function renderApontamentos(items) {
  var container = $('apontamentoContent');
  if (!items || items.length === 0) {
    container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">check_circle</span><p>Nenhuma equipe faltou no período selecionado</p></div>';
    return;
  }
  var html = '<div class="table-wrap"><table><thead><tr><th>Equipe</th><th>Data</th><th>Dia</th><th>Motivo</th>' + (isSupervisor() ? '' : '<th>Ação</th>') + '</tr></thead><tbody>';
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var inputId = 'apontamento_' + it.team_id + '_' + it.date.replace(/-/g, '');
    html += '<tr>' +
      '<td><strong>' + escapeHtml(it.team_name) + '</strong></td>' +
      '<td>' + formatDateBr(it.date) + '</td>' +
      '<td>' + it.day_name + '</td>' +
      '<td>' + (isSupervisor()
        ? escapeHtml(it.reason || '<span style="color:var(--text-muted);">—</span>')
        : '<input type="text" id="' + inputId + '" placeholder="Motivo da ausência..." value="' + escapeHtml(it.reason) + '" style="min-width:200px;">') + '</td>' +
      (isSupervisor() ? '' : '<td><button class="btn btn-sm btn-primary" onclick="saveApontamento(\'' + it.team_id + '\',\'' + it.date + '\',\'' + inputId + '\')"><span class="material-symbols-outlined">save</span> Salvar</button></td>') +
      '</tr>';
  }
  html += '</tbody></table></div>';
  container.innerHTML = html;
}

function saveApontamento(teamId, date, inputId) {
  if (!ensureAdmin()) return;
  var reason = $(inputId).value.trim();
  if (!reason) { toast('Informe o motivo', 'error'); return; }
  loading(true);
  var noteKey = teamId + '_' + date;
  var noteData = {
    team_id: teamId,
    date: date,
    reason: reason,
    created_by: currentUser ? currentUser.id : '',
    created_at: nowTimestamp()
  };
  fbOnce('shift_notes').then(function(existing) {
    var notes = toArray(existing);
    var found = notes.find(function(n) { return n.team_id === teamId && n.date === date; });
    if (found) {
      return fbUpdate('shift_notes/' + found.id, noteData).then(function() {
        loading(false);
        toast('Apontamento salvo!', 'success');
      });
    } else {
      return fbPush('shift_notes', noteData).then(function() {
        loading(false);
        toast('Apontamento salvo!', 'success');
      });
    }
  }).catch(function(err) {
    loading(false);
    toast('Erro ao salvar: ' + err.message, 'error');
  });
}

// --- Regras ---
function addRule() {
  if (!ensureAdmin()) return;
  var container = $('rulesContainer');
  var id = 'new_' + Date.now();
  var html = '<div class="rule-card" data-rule-id="' + id + '">' +
    '<div class="badge badge-sm" style="background:#94a3b8;">?</div>' +
    '<div class="fields">' +
    '<div class="form-group"><label>Classe</label><input type="text" class="rule-class" value="Nova Classe"></div>' +
    '<div class="form-group"><label>Mínimo</label><input type="number" class="rule-min" value="0"></div>' +
    '<div class="form-group"><label>Máximo</label><input type="number" class="rule-max" value="100"></div>' +
    '<div class="form-group"><label>Cor</label><input type="color" class="rule-color" value="#94a3b8"></div>' +
    '</div>' +
    '<button class="btn btn-ghost btn-sm" onclick="this.parentElement.remove()"><span class="material-symbols-outlined">delete</span></button>' +
    '</div>';
  if (container.querySelector('.empty-state')) { container.innerHTML = ''; }
  container.insertAdjacentHTML('beforeend', html);
}

function loadRules() {
  fbOnce('rules').then(function(rules) {
    rulesCache = toArray(rules).map(function(r) {
      return { id: r.id, class: r.class, minUps: r.min_ups, maxUps: r.max_ups, color: r.color };
    });
    renderRules(rulesCache);
  });
}

function renderRules(rules) {
  var container = $('rulesContainer');
  if (!rules || rules.length === 0) {
    container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">tune</span><p>Nenhuma regra configurada</p></div>';
    return;
  }
  var html = '<div class="rules-grid">';
  for (var i = 0; i < rules.length; i++) {
    var r = rules[i];
    html += '<div class="rule-card" data-rule-id="' + r.id + '">' +
      '<div class="badge badge-sm" style="background:' + r.color + ';">' + r.class + '</div>' +
      '<div class="fields">' +
      '<div class="form-group"><label>Classe</label><input type="text" class="rule-class" value="' + escapeHtml(r.class) + '"></div>' +
      '<div class="form-group"><label>Mínimo</label><input type="number" class="rule-min" value="' + r.minUps + '"></div>' +
      '<div class="form-group"><label>Máximo</label><input type="number" class="rule-max" value="' + r.maxUps + '"></div>' +
      '<div class="form-group"><label>Cor</label><input type="color" class="rule-color" value="' + r.color + '"></div>' +
      '</div>' +
      '<button class="btn btn-ghost btn-sm" onclick="this.parentElement.remove()"><span class="material-symbols-outlined">delete</span></button>' +
      '</div>';
  }
  html += '</div>';
  container.innerHTML = html;
}

function saveRules() {
  if (!ensureAdmin()) return;
  var cards = document.querySelectorAll('.rule-card');
  var rules = [];
  for (var i = 0; i < cards.length; i++) {
    var card = cards[i];
    rules.push({
      class: card.querySelector('.rule-class').value,
      min_ups: parseInt(card.querySelector('.rule-min').value),
      max_ups: parseInt(card.querySelector('.rule-max').value),
      color: card.querySelector('.rule-color').value
    });
  }
  loading(true);
  fbRemove('rules').then(function() {
    var promises = rules.map(function(r) { return fbPush('rules', r); });
    return Promise.all(promises);
  }).then(function() {
    loading(false);
    toast('Regras salvas!', 'success');
    loadRules();
  }).catch(function(err) {
    loading(false);
    toast('Erro: ' + err.message, 'error');
  });
}

// --- Mapa ---
function loadMapData(start, end) {
  start = start || todayStr();
  end = end || todayStr();
  getAllTeamsSummaryForPeriod(start, end).then(function(data) {
    updateMap(data);
  }).catch(function(err) {
    console.error('Erro ao carregar mapa:', err);
  });
}

var OWM_API_KEY = 'cb9a3186df512370a0b85db130ca34d1';

function initMap() {
  var container = $('map');
  if (!container) { console.error('Container do mapa nao encontrado'); return; }
  if (container._leaflet_id) { console.log('Mapa ja inicializado'); return; }
  try {
    map = L.map('map', { center: [-15.7939, -47.8828], zoom: 5, zoomControl: true });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
      subdomains: 'abcd', maxZoom: 20
    }).addTo(map);
    var terrainLayer = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://opentopomap.org">OpenTopoMap</a>', maxZoom: 17
    });
    var weatherLayer = L.tileLayer('https://tile.openweathermap.org/map/temp_new/{z}/{x}/{y}.png?appid=' + OWM_API_KEY, {
      attribution: '&copy; <a href="https://openweathermap.org">OpenWeatherMap</a>', opacity: 0.6, maxZoom: 18
    });
    L.control.layers(null, { 'Terreno': terrainLayer, 'Temperatura': weatherLayer }, { collapsed: true }).addTo(map);
    loadMapData();
  } catch (e) {
    console.error('Erro ao inicializar mapa:', e);
    toast('Erro ao carregar mapa: ' + e.message, 'error');
  }
}

function updateMap(data) {
  if (!map) return;
  for (var i = 0; i < mapMarkers.length; i++) map.removeLayer(mapMarkers[i]);
  mapMarkers = [];
  if (!data || data.length === 0) return;
  var bounds = [];
  for (var i = 0; i < data.length; i++) {
    var team = data[i];
    var lat = parseFloat(team.latitude);
    var lng = parseFloat(team.longitude);
    if (isNaN(lat) || isNaN(lng)) {
      var angle = (i / data.length) * 2 * Math.PI;
      var radius = 0.08;
      lat = -15.7939 + radius * Math.cos(angle);
      lng = -47.8828 + radius * Math.sin(angle);
    }
    var color = team.color || '#94a3b8';
    var icon = L.divIcon({
      className: 'custom-marker',
      html: '<div style="background:' + color + ';width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:16px;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.3);">' + team.class + '</div>',
      iconSize: [38, 38], iconAnchor: [19, 19], popupAnchor: [0, -22]
    });
    var radiusPixels = Math.max(20, Math.min(60, 20 + team.totalUps * 0.5));
    var circle = L.circleMarker([lat, lng], {
      radius: radiusPixels,
      fillColor: color,
      color: '#fff',
      weight: 2,
      opacity: 0.8,
      fillOpacity: 0.15
    }).addTo(map);
    mapMarkers.push(circle);

    var statusInfo = getStatusInfo(team.lastSeen);
    var statusDot = statusInfo.status === 'online' ? '🟢' : '🔴';
    var locLabel = '';
    if (team.address) {
      locLabel = escapeHtml(team.address.split(',')[0]);
    } else {
      locLabel = lat.toFixed(4) + ', ' + lng.toFixed(4);
    }
    var popupHtml = '<div class="custom-popup">' +
      '<div style="text-align:center;font-weight:700;font-size:16px;margin-bottom:6px;">' + escapeHtml(team.username) + '</div>' +
      '<div class="popup-header" style="justify-content:center;">' +
      '<span style="display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50%;background:' + color + ';color:#fff;font-weight:800;font-size:14px;">' + team.class + '</span>' +
      '</div>' +
      '<div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;text-align:center;">' + statusDot + ' ' + statusInfo.label + ' | <span class="coord-text">' + locLabel + '</span></div>';
    if (team.services && team.services.length > 0) {
      popupHtml += '<div class="popup-services"><table><tr><th>Serviço</th><th>UPS</th><th>R$</th></tr>';
      for (var j = 0; j < team.services.length; j++) {
        var sv = team.services[j];
        popupHtml += '<tr><td>' + escapeHtml(sv.serviceName) + (sv.quantity > 1 ? ' (' + sv.quantity + 'x)' : '') + '</td>' +
          '<td style="font-weight:600;">' + sv.upsValue + '</td>' +
          '<td style="font-weight:600;color:var(--money);">' + (sv.totalMoney ? fmtMoney(sv.totalMoney) : '-') + '</td></tr>';
      }
      popupHtml += '</table></div>' +
        '<div class="popup-total" style="background:' + color + ';color:#fff;">Total: ' + team.totalUps + ' UPS ' +
        (team.totalMoney ? '| ' + fmtMoney(team.totalMoney) : '') + '</div>';
    } else {
      popupHtml += '<div style="text-align:center;color:#94a3b8;padding:12px 0;font-size:13px;">Nenhum serviço hoje</div>' +
        '<div class="popup-total" style="background:' + color + ';color:#fff;">Total: 0 UPS</div>';
    }
    popupHtml += '</div>';
    var marker = L.marker([lat, lng], { icon: icon }).addTo(map).bindPopup(popupHtml, { maxWidth: 320, className: 'custom-popup' });
    marker.on('mouseover', function() { this.openPopup(); });
    marker.on('mouseout', function() { this.closePopup(); });
    mapMarkers.push(marker);
    bounds.push([lat, lng]);
    if (!team.address) {
      (function(marker, lat, lng) {
        reverseGeocode(lat, lng, function(addr) {
          if (marker.getPopup()) {
            var content = marker.getPopup().getContent();
            var coordSpan = content.match(/<span class="coord-text">[^<]+<\/span>/);
            if (coordSpan) {
              content = content.replace(coordSpan[0], '<span class="coord-text">' + addr.split(',')[0] + '</span>');
              marker.setPopupContent(content);
            }
          }
        });
      })(marker, lat, lng);
    }
  }
  if (bounds.length > 0) { map.fitBounds(bounds, { padding: [50, 50], maxZoom: 14 }); }
  for (var i = 0; i < data.length; i++) {
    var t = data[i];
    if (t.class === 'A' && !celebratedTeams.has(t.id)) {
      celebratedTeams.add(t.id);
      showCelebration(t);
    }
  }
}

function openTeamModal(userId) {
  var start = $('adminStartDate').value;
  var end = $('adminEndDate').value;
  loading(true);
  Promise.all([getTeamSummary(userId, start, end), fbOnce('users')]).then(function(results) {
    var summary = results[0];
    var users = toArray(results[1]);
    var user = users.find(function(u) { return u.id === userId; });
    loading(false);
    if (!summary) { toast('Erro ao buscar dados da equipe', 'error'); return; }
    var color = summary.color || '#94a3b8';
    var heroBadge = $('modalHeroBadge');
    heroBadge.textContent = summary.class;
    heroBadge.style.background = color;
    $('modalTeamName').textContent = user ? user.username : 'Desconhecido';
    var addrEl = $('modalAddressText');
    if (user && user.address) {
      addrEl.textContent = user.address;
    } else if (user && user.latitude) {
      addrEl.textContent = parseFloat(user.latitude).toFixed(4) + ', ' + parseFloat(user.longitude).toFixed(4);
    } else {
      addrEl.textContent = '—';
    }
    var supLine = $('modalSupervisorLine');
    if (user && user.supervisor) {
      supLine.style.display = 'block';
      $('modalSupervisorName').textContent = user.supervisor;
    } else {
      supLine.style.display = 'none';
    }
    $('modalTotalUps').textContent = summary.totalUps;
    $('modalTotalMoney').textContent = fmtMoney(summary.totalMoney || 0);
    $('modalSrvCount').textContent = summary.count;
    var classEl = $('modalClass');
    classEl.textContent = summary.class;
    classEl.style.color = color;
    var goalSection = $('modalGoalSection');
    if (user && user.goal_money > 0) {
      var goalPct = Math.min(100, Math.round((summary.totalMoney / user.goal_money) * 100));
      goalSection.style.display = 'block';
      $('modalGoalValue').textContent = fmtMoney(user.goal_money);
      $('modalGoalPercent').textContent = goalPct + '%';
      $('modalGoalBar').style.width = Math.min(100, (summary.totalMoney / user.goal_money) * 100) + '%';
      $('modalGoalBar').style.background = goalPct >= 100 ? 'var(--success)' : goalPct >= 70 ? 'var(--warning)' : 'var(--money)';
    } else {
      goalSection.style.display = 'none';
    }
    renderTeamDetails(summary.services);
    $('teamModal').style.display = 'flex';
  }).catch(function(err) {
    loading(false);
    toast('Erro: ' + err.message, 'error');
  });
}

function closeTeamModal() { $('teamModal').style.display = 'none'; }

function renderTeamDetails(services) {
  var container = $('modalServiceList');
  if (!services || services.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>Nenhum serviço no período</p></div>';
    return;
  }
  var html = '<div class="modal-srv-table"><table><thead><tr><th>Data</th><th>Serviço</th><th class="num">UPS</th><th class="num">R$</th><th class="num">Nota</th></tr></thead><tbody>';
  for (var i = 0; i < services.length; i++) {
    var s = services[i];
    html += '<tr>' +
      '<td class="date">' + formatDateBr(s.date) + '</td>' +
      '<td class="srv">' + escapeHtml(s.serviceName) + '</td>' +
      '<td class="num ups">' + fmtUps(s.upsValue) + '</td>' +
      '<td class="num money">' + fmtMoney(s.totalMoney || 0) + '</td>' +
      '<td class="num">' + (s.grade || '-') + '</td>' +
      '</tr>';
  }
  html += '</tbody></table></div>';
  container.innerHTML = html;
}

// --- Supervisores ---
function loadSupervisores() {
  var start = $('adminStartDate').value;
  var end = $('adminEndDate').value;
  getAllTeamsSummaryForPeriod(start, end).then(function(data) {
    renderSupervisores(data);
  }).catch(function(err) {
    console.error('Erro ao carregar supervisores:', err);
  });
}

function renderSupervisores(data) {
  var container = $('supervisoresContent');
  if (!data || data.length === 0) {
    container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">supervisor_account</span><p>Nenhuma equipe com supervisor cadastrado</p></div>';
    return;
  }
  var supervisors = {};
  data.forEach(function(t) {
    var sup = t.supervisor || 'Sem Supervisor';
    if (!supervisors[sup]) {
      supervisors[sup] = { teams: [], totalUps: 0, totalMoney: 0, totalGoal: 0, totalServices: 0, classes: [] };
    }
    supervisors[sup].teams.push(t);
    supervisors[sup].totalUps += t.totalUps;
    supervisors[sup].totalMoney += t.totalMoney;
    supervisors[sup].totalGoal += t.goal_money || 0;
    supervisors[sup].totalServices += t.count;
    supervisors[sup].classes.push(t.class);
  });

  var supNames = Object.keys(supervisors).sort(function(a, b) {
    return supervisors[b].totalUps - supervisors[a].totalUps;
  });

  var html = '';
  for (var i = 0; i < supNames.length; i++) {
    var supName = supNames[i];
    var sup = supervisors[supName];
    var supId = 'sup_' + i;
    var medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '#' + (i + 1);
    var goalPct = sup.totalGoal > 0 ? Math.min(100, Math.round((sup.totalMoney / sup.totalGoal) * 100)) : 0;
    var avgUps = sup.teams.length > 0 ? (sup.totalUps / sup.teams.length).toFixed(1) : 0;

    html += '<div class="card" style="margin-bottom:12px;overflow:hidden;">';
    html += '<div class="ranking-item" style="cursor:pointer;padding:16px 20px;margin:0;border:none;border-radius:0;background:transparent;" onclick="toggleSupervisor(\'' + supId + '\')">' +
      '<div class="ranking-pos">' + medal + '</div>' +
      '<div class="ranking-info">' +
      '<div class="ranking-name" style="font-size:15px;">' + escapeHtml(supName) + ' <span style="font-size:12px;color:var(--text-muted);font-weight:400;vertical-align:middle;" id="supArrow_' + supId + '">▶</span></div>' +
      '<div class="ranking-status" style="color:var(--text-muted);">' + sup.teams.length + ' equipe' + (sup.teams.length !== 1 ? 's' : '') + ' | Média: ' + avgUps + ' UPS/equipe</div>' +
      (sup.totalGoal > 0 ? '<div style="margin-top:6px;"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;"><span style="font-size:10px;color:var(--text-muted);">Meta: ' + fmtMoney(sup.totalGoal) + '</span><span style="font-size:10px;font-weight:700;color:var(--money);">' + goalPct + '%</span></div><div style="width:100%;height:6px;background:var(--border);border-radius:3px;overflow:hidden;"><div style="height:100%;background:var(--money);border-radius:3px;width:' + goalPct + '%;"></div></div></div>' : '') +
      '</div>' +
      '<div class="ranking-stats">' +
      '<div class="ranking-ups">' + sup.totalUps + ' UPS</div>' +
      '<div class="ranking-money">' + fmtMoney(sup.totalMoney) + '</div>' +
      '<div class="ranking-count">' + sup.totalServices + ' serviço' + (sup.totalServices !== 1 ? 's' : '') + '</div>' +
      '</div>' +
      '</div>';

    html += '<div id="' + supId + '" style="display:none;padding:0 14px 14px;border-top:1px solid var(--border-light);">';
    html += '<div class="table-wrap"><table><thead><tr><th>Equipe</th><th>Classe</th><th>UPS</th><th>R$</th><th>Serviços</th><th>Meta</th><th>Progresso</th></tr></thead><tbody>';
    sup.teams.sort(function(a, b) { return b.totalUps - a.totalUps; }).forEach(function(t) {
      var teamGoalPct = t.goal_money > 0 ? Math.min(100, Math.round((t.totalMoney / t.goal_money) * 100)) : 0;
      var teamColor = t.color || '#94a3b8';
      html += '<tr style="cursor:pointer;" onclick="openTeamModal(\'' + t.userId + '\')">' +
        '<td><strong>' + escapeHtml(t.username) + '</strong></td>' +
        '<td><span style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:' + teamColor + ';color:#fff;font-weight:800;font-size:12px;">' + t.class + '</span></td>' +
        '<td style="font-weight:700;color:var(--primary);">' + t.totalUps + '</td>' +
        '<td style="font-weight:600;color:var(--money);">' + fmtMoney(t.totalMoney) + '</td>' +
        '<td>' + t.count + '</td>' +
        '<td>' + (t.goal_money > 0 ? fmtMoney(t.goal_money) : '<span style="color:var(--text-muted);">—</span>') + '</td>' +
        '<td style="min-width:120px;">';
      if (t.goal_money > 0) {
        html += '<div style="display:flex;align-items:center;gap:6px;"><div style="flex:1;height:6px;background:var(--border);border-radius:3px;overflow:hidden;"><div style="height:100%;background:' + (teamGoalPct >= 100 ? 'var(--success)' : teamGoalPct >= 70 ? 'var(--warning)' : 'var(--money)') + ';border-radius:3px;width:' + teamGoalPct + '%;"></div></div><span style="font-size:11px;font-weight:700;min-width:30px;text-align:right;">' + teamGoalPct + '%</span></div>';
      } else {
        html += '<span style="color:var(--text-muted);font-size:11px;">Sem meta</span>';
      }
      html += '</td></tr>';
    });
    html += '</tbody></table></div></div>';
    html += '</div>';
  }

  if (supNames.length === 0) {
    html = '<div class="empty-state"><span class="material-symbols-outlined">supervisor_account</span><p>Nenhuma equipe com supervisor cadastrado</p></div>';
  }
  container.innerHTML = html;
}

function toggleSupervisor(supId) {
  var el = $(supId);
  var arrow = $('supArrow_' + supId);
  if (!el) return;
  if (el.style.display === 'none') {
    el.style.display = 'block';
    if (arrow) arrow.textContent = '▼';
  } else {
    el.style.display = 'none';
    if (arrow) arrow.textContent = '▶';
  }
}

// --- Auditoria ---
var auditoriaUsersCache = [];

function initAuditoria() {
  if (!$('auditoriaStartDate').value) {
    defaultPeriodForInputs('auditoriaStartDate', 'auditoriaEndDate');
  }
  fbOnce('users').then(function(users) {
    auditoriaUsersCache = toArray(users).filter(function(u) { return u.role !== 'admin' && canViewTeam(u.id); });
  });
}

function setAuditoriaCurrentMonth() {
  defaultPeriodForInputs('auditoriaStartDate', 'auditoriaEndDate');
  loadAuditoria();
}

function loadAuditoria() {
  var start = clampDateToAllowed($('auditoriaStartDate').value);
  var end = clampDateToAllowed($('auditoriaEndDate').value);
  $('auditoriaStartDate').value = start;
  $('auditoriaEndDate').value = end;
  if (!start || !end) {
    showMsg('auditoriaMsg', 'error', 'Selecione o período');
    return;
  }
  if (start > end) {
    showMsg('auditoriaMsg', 'error', 'Data início deve ser anterior à data fim');
    return;
  }
  clearMsg('auditoriaMsg');
  loading(true);
  Promise.all([fbOnce('services'), fbOnce('users'), fbOnce('catalog_services')]).then(function(results) {
    loading(false);
    var allServices = toArray(results[0]);
    var users = toArray(results[1]);
    var catalog = toArray(results[2]);
    auditoriaUsersCache = users.filter(function(u) { return u.role !== 'admin' && canViewTeam(u.id); });
    var userMap = {};
    users.forEach(function(u) { userMap[u.id] = u.username; });
    var filtered = allServices.filter(function(s) {
      return s.date >= start && s.date <= end && canViewTeam(s.user_id);
    });
    filtered.sort(function(a, b) {
      if (a.date === b.date) return (a.created_at || 0) - (b.created_at || 0);
      return a.date > b.date ? -1 : 1;
    });
    renderAuditoria(filtered, userMap, catalog);
  }).catch(function(err) {
    loading(false);
    showMsg('auditoriaMsg', 'error', 'Erro: ' + err.message);
  });
}

function renderAuditoria(services, userMap, catalog) {
  var container = $('auditoriaContent');
  if (!services || services.length === 0) {
    container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">fact_check</span><p>Nenhum lançamento encontrado no período</p></div>';
    return;
  }
  var totalUps = services.reduce(function(s, sv) { return s + (sv.ups_value || 0); }, 0);
  var totalMoney = services.reduce(function(s, sv) { return s + (sv.total_money || 0); }, 0);
  var html = '<div class="stats-overview" style="margin-bottom:12px;">' +
    '<div class="stat-box"><span class="stat-box-icon services"><span class="material-symbols-outlined">assignment</span></span><div><div class="stat-box-value">' + services.length + '</div><div class="stat-box-label">Lançamentos</div></div></div>' +
    '<div class="stat-box"><span class="stat-box-icon ups"><span class="material-symbols-outlined">trending_up</span></span><div><div class="stat-box-value">' + totalUps + '</div><div class="stat-box-label">Total UPS</div></div></div>' +
    '<div class="stat-box"><span class="stat-box-icon money"><span class="material-symbols-outlined">payments</span></span><div><div class="stat-box-value">' + fmtMoney(totalMoney) + '</div><div class="stat-box-label">Total R$</div></div></div>' +
    '</div>';
  html += '<div class="table-wrap"><table><thead><tr>' +
    '<th>Data</th><th>Equipe</th><th>Serviço</th><th>Tipo</th><th class="num">Qtd</th><th class="num">UPS</th><th class="num">R$</th><th class="num">Nota</th>' + (isSupervisor() ? '' : '<th>Ações</th>') +
    '</tr></thead><tbody>';
  for (var i = 0; i < services.length; i++) {
    var s = services[i];
    var teamName = userMap[s.user_id] || 'Desconhecido';
    var typeLabel = s.type === 'miscellany' ? 'Miscelânea' : (s.type === 'emergency' ? 'Emergência' : (s.type === 'commercial' ? 'Comercial' : s.type || ''));
    var timeDisplay = s.time || '';
    html += '<tr>' +
      '<td style="white-space:nowrap;font-size:12px;">' + formatDateBr(s.date) + (timeDisplay ? ' ' + timeDisplay : '') + '</td>' +
      '<td><strong>' + escapeHtml(teamName) + '</strong></td>' +
      '<td style="font-weight:600;font-size:12px;">' + escapeHtml(s.service_name || '') + '</td>' +
      '<td style="font-size:12px;">' + typeLabel + '</td>' +
      '<td class="num">' + (s.quantity || 1) + '</td>' +
      '<td class="num" style="font-weight:700;color:var(--primary);">' + fmtUps(s.ups_value || 0) + '</td>' +
      '<td class="num" style="font-weight:600;color:var(--money);">' + fmtMoney(s.total_money || 0) + '</td>' +
      '<td class="num">' + (s.grade > 0 ? s.grade : '-') + '</td>' +
      (isSupervisor() ? '' : '<td class="actions">' +
      '<button class="btn btn-sm btn-outline" onclick="editAuditoriaService(\'' + s.id + '\')"><span class="material-symbols-outlined">edit</span></button>' +
      '<button class="btn btn-sm btn-danger" onclick="deleteAuditoriaService(\'' + s.id + '\')"><span class="material-symbols-outlined">delete</span></button>' +
      '</td>') +
      '</tr>';
  }
  html += '</tbody></table></div>';
  container.innerHTML = html;
}

function editAuditoriaService(serviceId) {
  if (!ensureAdmin()) return;
  loading(true);
  Promise.all([fbOnce('services/' + serviceId), fbOnce('users')]).then(function(results) {
    loading(false);
    var service = results[0];
    if (!service) { toast('Lançamento não encontrado', 'error'); return; }
    var users = toArray(results[1]).filter(function(u) { return u.role !== 'admin'; });
    $('editServiceId').value = serviceId;
    var userSelect = $('editServiceUserId');
    userSelect.innerHTML = '';
    for (var i = 0; i < users.length; i++) {
      var opt = document.createElement('option');
      opt.value = users[i].id;
      opt.textContent = users[i].username;
      if (users[i].id === service.user_id) opt.selected = true;
      userSelect.appendChild(opt);
    }
    $('editServiceType').value = service.type || 'miscellany';
    $('editServiceGrade').value = service.grade || '';
    $('editServiceQty').value = service.quantity || 1;
    $('editServiceUps').value = service.ups_value || 0;
    $('editServiceMoney').value = service.total_money || 0;
    $('editServiceName').value = service.service_name || '';
    var now = new Date();
    $('editServiceDate').value = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    $('editServiceTime').value = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') + ':' + String(now.getSeconds()).padStart(2, '0');
    $('editServiceLocationText').textContent = 'Capturando localização...';
    clearMsg('editServiceMsg');
    $('editServiceModal').style.display = 'flex';
    window._editServiceLat = '';
    window._editServiceLng = '';
    window._editServiceCity = '';
    window._editServiceAddress = '';
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(function(pos) {
        window._editServiceLat = pos.coords.latitude;
        window._editServiceLng = pos.coords.longitude;
        reverseGeocode(pos.coords.latitude, pos.coords.longitude, function(addr) {
          window._editServiceAddress = addr;
          window._editServiceCity = (addr.split(',')[1] || addr.split(',')[0] || '').trim();
          $('editServiceLocationText').textContent = addr;
        });
      }, function(err) {
        $('editServiceLocationText').textContent = 'Não foi possível obter localização';
      }, { enableHighAccuracy: true, timeout: 10000 });
    }
  }).catch(function(err) {
    loading(false);
    toast('Erro: ' + err.message, 'error');
  });
}

function saveEditService() {
  if (!ensureAdmin()) return;
  var id = $('editServiceId').value;
  var userId = $('editServiceUserId').value;
  var type = $('editServiceType').value;
  var grade = parseInt($('editServiceGrade').value) || 0;
  var qty = parseInt($('editServiceQty').value) || 1;
  var ups = parseFloat($('editServiceUps').value) || 0;
  var money = parseFloat($('editServiceMoney').value) || 0;
  var serviceName = $('editServiceName').value.trim();
  var date = $('editServiceDate').value;
  var time = $('editServiceTime').value;

  if (!userId) { showMsg('editServiceMsg', 'error', 'Selecione uma equipe'); return; }
  if (!serviceName) { showMsg('editServiceMsg', 'error', 'Informe o nome do serviço'); return; }

  var upsPerUnit = qty > 0 ? ups / qty : ups;
  var moneyPerUnit = qty > 0 && money > 0 ? money / qty : 0;

  var updateData = {
    user_id: userId,
    type: type,
    grade: grade,
    quantity: qty,
    ups_value: ups,
    total_money: money,
    ups_per_unit: upsPerUnit,
    money_per_unit: moneyPerUnit,
    service_name: serviceName,
    date: date,
    time: time,
    latitude: window._editServiceLat || '',
    longitude: window._editServiceLng || '',
    city: window._editServiceCity || '',
    address: window._editServiceAddress || '',
    edited_by: currentUser ? currentUser.username : '',
    edited_at: nowTimestamp()
  };

  loading(true);
  fbUpdate('services/' + id, updateData).then(function() {
    loading(false);
    toast('Lançamento atualizado com sucesso!', 'success');
    closeEditServiceModal();
    loadAuditoria();
  }).catch(function(err) {
    loading(false);
    showMsg('editServiceMsg', 'error', 'Erro: ' + err.message);
  });
}

function deleteAuditoriaService(serviceId) {
  if (!ensureAdmin()) return;
  if (!confirm('Excluir este lançamento? Esta ação não pode ser desfeita.')) return;
  loading(true);
  fbRemove('services/' + serviceId).then(function() {
    loading(false);
    toast('Lançamento excluído', 'info');
    loadAuditoria();
  }).catch(function(err) {
    loading(false);
    toast('Erro: ' + err.message, 'error');
  });
}

function closeEditServiceModal() {
  $('editServiceModal').style.display = 'none';
}

// --- Classificação ---
function toggleKanbanCard(id) {
  var card = document.getElementById(id);
  if (card) card.classList.toggle('collapsed');
}

function initClassificacao() {
  if (!$('classificacaoStartDate').value) {
    defaultPeriodForInputs('classificacaoStartDate', 'classificacaoEndDate');
  }
}

function setClassificacaoCurrentMonth() {
  defaultPeriodForInputs('classificacaoStartDate', 'classificacaoEndDate');
  loadClassificacao();
}

function loadClassificacao() {
  var start = clampDateToAllowed($('classificacaoStartDate').value);
  var end = clampDateToAllowed($('classificacaoEndDate').value);
  $('classificacaoStartDate').value = start;
  $('classificacaoEndDate').value = end;
  if (!start || !end) {
    showMsg('classificacaoMsg', 'error', 'Selecione o período');
    return;
  }
  if (start > end) {
    showMsg('classificacaoMsg', 'error', 'Data início deve ser anterior à data fim');
    return;
  }
  clearMsg('classificacaoMsg');
  loading(true);
  Promise.all([fbOnce('users'), fbOnce('services'), fbOnce('rules')]).then(function(results) {
    loading(false);
    var users = toArray(results[0]).filter(function(u) { return u.role !== 'admin' && canViewTeam(u.id); });
    var allServices = toArray(results[1]);
    rulesCache = toArray(results[2]).map(function(r) {
      return { id: r.id, class: r.class, minUps: r.min_ups, maxUps: r.max_ups, color: r.color };
    });

    var teamsData = users.map(function(user) {
      var svcs = allServices.filter(function(s) {
        return s.user_id === user.id && s.date >= start && s.date <= end;
      });
      var services = svcs.map(function(s) { return formatService(s); });
      var totalUps = services.reduce(function(sum, sv) { return sum + sv.upsValue; }, 0);
      var totalMoney = services.reduce(function(sum, sv) { return sum + (sv.totalMoney || 0); }, 0);

      var uniqueDays = {};
      for (var i = 0; i < services.length; i++) {
        if (services[i].date) uniqueDays[services[i].date] = true;
      }
      var daysCount = Object.keys(uniqueDays).length;
      var avgUps = daysCount > 0 ? totalUps / daysCount : 0;
      var classInfo = getClassification(avgUps);

      return {
        userId: user.id,
        username: user.username,
        supervisor: user.supervisor || '',
        totalUps: totalUps,
        totalMoney: totalMoney,
        daysCount: daysCount,
        avgUps: avgUps,
        servicesCount: services.length,
        class: classInfo.class,
        color: classInfo.color
      };
    });

    // Supervisor aggregation (média das médias das equipes)
    var supMap = {};
    for (var i = 0; i < teamsData.length; i++) {
      var t = teamsData[i];
      var supName = t.supervisor || 'Sem Supervisor';
      if (!supMap[supName]) {
        supMap[supName] = { name: supName, avgUpsSum: 0, teamsCount: 0, totalUps: 0, totalMoney: 0, servicesCount: 0 };
      }
      supMap[supName].avgUpsSum += t.avgUps;
      supMap[supName].teamsCount += 1;
      supMap[supName].totalUps += t.totalUps;
      supMap[supName].totalMoney += t.totalMoney;
      supMap[supName].servicesCount += t.servicesCount;
    }
    var supData = [];
    var supKeys = Object.keys(supMap);
    for (var k = 0; k < supKeys.length; k++) {
      var sup = supMap[supKeys[k]];
      var supAvgUps = sup.teamsCount > 0 ? sup.avgUpsSum / sup.teamsCount : 0;
      var supClass = getClassification(supAvgUps);
      supData.push({
        name: sup.name,
        totalUps: sup.totalUps,
        totalMoney: sup.totalMoney,
        avgUps: supAvgUps,
        teamsCount: sup.teamsCount,
        servicesCount: sup.servicesCount,
        class: supClass.class,
        color: supClass.color
      });
    }

    renderClassificacao(teamsData, supData, start, end);
  }).catch(function(err) {
    loading(false);
    showMsg('classificacaoMsg', 'error', 'Erro: ' + err.message);
  });
}

function buildKanbanHtml(groups, classOrder, classLabels, classIcons, classColors, isSupervisor) {
  var html = '<div class="kanban-board">';
  for (var c = 0; c < classOrder.length; c++) {
    var clsKey = classOrder[c];
    var colTeams = groups[clsKey] || [];
    var colColor = classColors[clsKey];
    html += '<div class="kanban-column">';
    html += '<div class="kanban-column-header" style="border-color:' + colColor + ';">';
    html += '<span class="col-label" style="color:' + colColor + ';"><span class="material-symbols-outlined" style="font-size:14px;vertical-align:middle;margin-right:3px;">' + classIcons[clsKey] + '</span>' + classLabels[clsKey] + '</span>';
    html += '<span class="col-count">' + colTeams.length + '</span>';
    html += '</div>';
    html += '<div class="kanban-column-body">';
    if (colTeams.length === 0) {
      html += '<div class="kanban-empty"><span class="material-symbols-outlined">inbox</span>Nenhum' + (isSupervisor ? ' supervisor' : ' item') + '</div>';
    } else {
      for (var j = 0; j < colTeams.length; j++) {
        var item = colTeams[j];
        var cardId = (isSupervisor ? 'sup-card-' : 'team-card-') + clsKey + '-' + j;
        html += '<div class="kanban-card collapsed" id="' + cardId + '">';
        html += '<div class="card-header">';
        html += '<div class="card-name" style="color:' + colColor + ';">' + escapeHtml(item.username || item.name) + '</div>';
        html += '<button class="card-toggle" onclick="toggleKanbanCard(\'' + cardId + '\')"><span class="material-symbols-outlined">expand_more</span></button>';
        html += '</div>';
        html += '<div class="card-info">';
        html += '<span><span class="material-symbols-outlined">trending_up</span>Média: <strong>' + fmtUps(item.avgUps) + '</strong> UPS/dia</span>';
        if (isSupervisor) {
          html += '<span><span class="material-symbols-outlined">groups</span>' + item.teamsCount + ' equipe' + (item.teamsCount !== 1 ? 's' : '') + '</span>';
        } else {
          html += '<span><span class="material-symbols-outlined">date_range</span>' + item.daysCount + ' dia' + (item.daysCount !== 1 ? 's' : '') + ' trabalhado' + (item.daysCount !== 1 ? 's' : '') + '</span>';
        }
        html += '<span><span class="material-symbols-outlined">functions</span>Total: ' + fmtUps(item.totalUps) + ' UPS em ' + item.servicesCount + ' lançamento' + (item.servicesCount !== 1 ? 's' : '') + '</span>';
        if (!isSupervisor && item.supervisor) {
          html += '<span><span class="material-symbols-outlined">supervisor_account</span>' + escapeHtml(item.supervisor) + '</span>';
        }
        html += '</div></div>';
      }
    }
    html += '</div></div>';
  }
  html += '</div>';
  return html;
}

function renderClassificacao(teamsData, supData, startDate, endDate) {
  var container = $('classificacaoContent');
  if (!teamsData || teamsData.length === 0) {
    container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">groups</span><p>Nenhuma equipe encontrada</p></div>';
    return;
  }

  var classLabels = { A: 'Classe A', B: 'Classe B', C: 'Classe C', D: 'Classe D' };
  var classIcons = { A: 'emoji_events', B: 'military_tech', C: 'workspace_premium', D: 'trending_down' };
  var classColors = { A: '#2ecc71', B: '#3498db', C: '#f39c12', D: '#e74c3c' };
  var classOrder = ['A', 'B', 'C', 'D'];

  // Team groups
  var groups = { A: [], B: [], C: [], D: [] };
  for (var i = 0; i < teamsData.length; i++) {
    var cls = teamsData[i].class;
    if (!groups[cls]) groups[cls] = [];
    groups[cls].push(teamsData[i]);
  }
  Object.keys(groups).forEach(function(k) {
    groups[k].sort(function(a, b) { return b.avgUps - a.avgUps; });
  });

  // Supervisor groups
  var supGroups = { A: [], B: [], C: [], D: [] };
  for (var s = 0; s < supData.length; s++) {
    var sCls = supData[s].class;
    if (!supGroups[sCls]) supGroups[sCls] = [];
    supGroups[sCls].push(supData[s]);
  }
  Object.keys(supGroups).forEach(function(k) {
    supGroups[k].sort(function(a, b) { return b.avgUps - a.avgUps; });
  });

  var totalTeams = teamsData.length;
  var totalSup = supData.length;
  var html = '<div class="stats-overview" style="margin-bottom:10px;">';
  html += '<div class="stat-box"><span class="stat-box-icon teams"><span class="material-symbols-outlined">groups</span></span><div><div class="stat-box-value">' + totalTeams + '</div><div class="stat-box-label">Equipes</div></div></div>';
  html += '<div class="stat-box"><span class="stat-box-icon services"><span class="material-symbols-outlined">supervisor_account</span></span><div><div class="stat-box-value">' + totalSup + '</div><div class="stat-box-label">Supervisores</div></div></div>';
  html += '<div class="stat-box"><span class="stat-box-icon ups"><span class="material-symbols-outlined">calendar_month</span></span><div><div class="stat-box-value" style="font-size:12px;">' + formatDateBr(startDate) + ' a ' + formatDateBr(endDate) + '</div><div class="stat-box-label">Período</div></div></div>';
  html += '</div>';

  html += '<div class="kanban-section-title"><span class="material-symbols-outlined">groups</span> Classificação das Equipes</div>';
  html += buildKanbanHtml(groups, classOrder, classLabels, classIcons, classColors, false);

  html += '<div class="kanban-section-title"><span class="material-symbols-outlined">supervisor_account</span> Classificação dos Supervisores</div>';
  html += buildKanbanHtml(supGroups, classOrder, classLabels, classIcons, classColors, true);

  container.innerHTML = html;
}

// ===== OFFLINE / SINCRONIZAÇÃO / ATUALIZAÇÃO =====
var syncStatusTimer = null;
var updateCheckTimer = null;

function updateSyncStatus() {
  if (!window.OfflineDB) return;
  OfflineDB.getStatus().then(function(st) {
    var chip = $('syncChip');
    if (!chip) return;
    var txt = $('syncText');
    if (st.pending > 0) {
      chip.className = 'sync-chip sync-pending';
      txt.textContent = (st.online ? 'Sincronizando' : 'Offline') + ' • ' + st.pending + ' pendente' + (st.pending !== 1 ? 's' : '');
    } else if (!st.online) {
      chip.className = 'sync-chip sync-offline';
      txt.textContent = 'Offline';
    } else {
      chip.className = 'sync-chip sync-online';
      txt.textContent = 'Online • Sincronizado';
    }
  }).catch(function() {});
}

function onOnline() {
  updateSyncStatus();
  OfflineDB.requestSync().then(function(flushed) {
    updateSyncStatus();
    if (flushed) {
      toast('Conexão restaurada. Dados sincronizados!', 'success');
      refreshAfterSync();
    }
  });
  checkForUpdate();
}

function onOffline() {
  updateSyncStatus();
  toast('Sem conexão. O app continua funcionando offline.', 'warning');
}

function onVisibilityChange() {
  if (document.visibilityState !== 'visible') return;
  checkForUpdate();
  if (OfflineDB.isOnline()) OfflineDB.requestSync();
  updateSyncStatus();
}

function refreshAfterSync() {
  if (!currentUser) return;
  if (currentUser.role === 'admin' || currentUser.role === 'supervisor') {
    initAdminView();
  } else if (currentUser.role === 'user') {
    initMonitorView(false);
  } else {
    refreshTeamView();
    loadTeamCatalog();
  }
}

// ===== ATUALIZAÇÃO OBRIGATÓRIA =====
function checkForUpdate() {
  if (!window.OfflineDB || !navigator.onLine) return;
  fetch('version.json?t=' + Date.now(), { cache: 'no-store' }).then(function(r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }).then(function(data) {
    var serverV = data && data.version;
    if (serverV && serverV !== APP_VERSION) {
      showUpdateModal(serverV);
    }
  }).catch(function() {});
}

function showUpdateModal(serverV) {
  var modal = $('updateModal');
  if (!modal) return;
  if ($('updateVersionText')) $('updateVersionText').textContent = serverV;
  modal.classList.add('active');
}

function applyUpdate() {
  var btn = $('updateNowBtn');
  var restoreBtn = function() {
    if (btn) { btn.disabled = false; btn.textContent = 'Atualizar agora'; }
  };
  if (btn) { btn.disabled = true; btn.textContent = 'Atualizando...'; }

  var reloaded = false;
  var forceReload = function() {
    if (reloaded) return;
    reloaded = true;
    if ('caches' in window) {
      caches.keys().then(function(keys) {
        return Promise.all(keys.map(function(k) { return caches.delete(k); }));
      }).catch(function() {}).then(function() {
        window.location.reload();
      });
    } else {
      window.location.reload();
    }
  };

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', forceReload);
    navigator.serviceWorker.getRegistration().then(function(reg) {
      if (!reg) { forceReload(); return; }
      reg.update().catch(function() {});
      setTimeout(forceReload, 3000);
    }).catch(function() {
      setTimeout(forceReload, 3000);
    });
  } else {
    window.location.reload();
  }

  setTimeout(restoreBtn, 10000);
}

// ===== INSTALAÇÃO (PWA) =====
var deferredInstallPrompt = null;
var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
var isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function isInAppBrowser() {
  return /FBAN|FBAV|Instagram|Line|WhatsApp|Messenger|MicroMessenger|KAKAOTALK/i.test(navigator.userAgent);
}

function captureInstallPrompt() {
  window.addEventListener('beforeinstallprompt', function(e) {
    e.preventDefault();
    deferredInstallPrompt = e;
    var banner = $('installBanner');
    if (banner) banner.style.display = (isStandalone || isInAppBrowser()) ? 'none' : 'flex';
  });
  window.addEventListener('appinstalled', function() {
    var banner = $('installBanner');
    if (banner) banner.style.display = 'none';
    deferredInstallPrompt = null;
    toast('Aplicativo instalado!', 'success');
  });
}

function installApp() {
  if (isStandalone) { toast('O aplicativo já está instalado.', 'info'); return; }
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    deferredInstallPrompt.userChoice.then(function(choice) {
      deferredInstallPrompt = null;
      var banner = $('installBanner');
      if (banner) banner.style.display = 'none';
    });
    return;
  }
  showInstallHelp();
}

function showInstallHelp() {
  var introEl = $('installHelpIntro');
  var stepsEl = $('installHelpSteps');
  var html = '';
  var intro = '';
  if (isInAppBrowser()) {
    intro = 'Este navegador não permite instalar o aplicativo. Abra o endereço no Chrome (Android) ou no Safari (iPhone).';
    html = '<div class="install-help-step"><b>1.</b><span>Copie o endereço da página e abra no <strong>Chrome</strong> ou <strong>Safari</strong>.</span></div>' +
      '<div class="install-help-step"><b>2.</b><span>Depois é só tocar no botão <strong>Instalar</strong> que aparece na tela.</span></div>';
  } else if (isIOS) {
    intro = 'No iPhone, a instalação é feita pelo menu do Safari:';
    html = '<div class="install-help-step"><b>1.</b><span>Toque no botão <strong>Compartilhar</strong> (ícone ↑ dentro de um quadrado).</span></div>' +
      '<div class="install-help-step"><b>2.</b><span>Role para baixo e toque em <strong>Adicionar à Tela de Início</strong>.</span></div>' +
      '<div class="install-help-step"><b>3.</b><span>Toque em <strong>Adicionar</strong> no canto superior direito.</span></div>' +
      '<div class="install-help-step"><b>4.</b><span>O ícone do UPS aparecerá na tela inicial como um aplicativo.</span></div>';
  } else {
    intro = 'No Android, use o navegador Chrome:';
    html = '<div class="install-help-step"><b>1.</b><span>Toque no botão <strong>Instalar</strong> deste aviso (se ele aparecer).</span></div>' +
      '<div class="install-help-step"><b>2.</b><span>Ou toque no menu <strong>⋮</strong> → <strong>Instalar aplicativo</strong> (ou <strong>Adicionar à tela inicial</strong>).</span></div>' +
      '<div class="install-help-step"><b>3.</b><span>Confirme em <strong>Instalar</strong>. O app será instalado como um programa.</span></div>';
  }
  introEl.textContent = intro;
  stepsEl.innerHTML = html;
  $('installHelpModal').style.display = 'flex';
}

function closeInstallHelp() {
  $('installHelpModal').style.display = 'none';
}

captureInstallPrompt();

// ===== GLOBAL ERROR CATCHER =====
window.onerror = function(msg, url, line) {
  console.error('Erro global:', msg, url, line);
  loading(false);
  return true;
};
window.addEventListener('unhandledrejection', function(e) {
  console.error('Promise rejeitada sem tratamento:', e.reason);
  loading(false);
});

// ===== INIT =====
document.addEventListener('DOMContentLoaded', function() {
  var savedUser = localStorage.getItem('ups_user');
  var savedPass = localStorage.getItem('ups_pass');
  if (savedUser && savedPass) {
    $('loginUser').value = savedUser;
    $('loginPass').value = savedPass;
    $('rememberMe').checked = true;
  }

  // Configura a camada offline e eventos de rede
  OfflineDB.setBaseUrl(DB_BASE_URL);
  OfflineDB.setStatusCallback(updateSyncStatus);
  OfflineDB.init().then(function() {
    OfflineDB.prune();
    OfflineDB.sync();
    updateSyncStatus();
  });

  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('focus', function() { onVisibilityChange(); });

  syncStatusTimer = setInterval(updateSyncStatus, 5000);
  checkForUpdate();
  updateCheckTimer = setInterval(checkForUpdate, 60000);

  seedData().then(function() { return fbOnce('rules'); }).then(function(rules) {
    rulesCache = toArray(rules).map(function(r) {
      return { id: r.id, class: r.class, minUps: r.min_ups, maxUps: r.max_ups, color: r.color };
    });
  }).catch(function(err) {
    console.error('Erro na inicialização:', err);
    showMsg('loginMsg', 'error', 'Erro ao conectar ao Firebase: ' + err.message);
  }).then(function() {
    loading(false);
  });
  $('loginUser').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); $('loginPass').focus(); }
  });
  $('loginPass').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); doLogin(); }
  });
});
