// ===== FIREBASE CONFIG =====
var DB_BASE_URL = 'https://babearia-jhosuan-default-rtdb.firebaseio.com';

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

// ===== FIREBASE HELPERS (REST API) =====
function fbUrl(path) {
  return DB_BASE_URL + (path ? '/' + path : '') + '.json';
}

function fbOnce(path) {
  return fetch(fbUrl(path)).then(function(r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
}

function fbPush(path, data) {
  return fetch(fbUrl(path), { method: 'POST', body: JSON.stringify(data) }).then(function(r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }).then(function(resp) {
    var key = resp.name;
    data.id = key;
    return key;
  });
}

function fbUpdate(path, data) {
  return fetch(fbUrl(path), { method: 'PATCH', body: JSON.stringify(data) }).then(function(r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
}

function fbRemove(path) {
  return fetch(fbUrl(path), { method: 'DELETE' }).then(function(r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
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

// ===== SEED DATA =====
function seedData() {
  return fbOnce('_initialized').then(function(init) {
    if (init) return;
    var promises = [];
    promises.push(fbPush('users', {
      username: 'admin', password: 'admin123', role: 'admin',
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
        found = { id: keys[i], username: u.username, role: u.role };
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
      if (found.role === 'admin') {
        initAdminView();
      } else {
        initTeamView();
      }
    } else {
      showMsg('loginMsg', 'error', 'Usuário ou senha inválidos');
    }
  }).catch(function(err) {
    loading(false);
    showMsg('loginMsg', 'error', 'Erro de conexão: ' + err.message);
  });
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
  fbUpdate('users/' + currentUser.id, { last_seen: nowTimestamp() }).catch(function(err) {});
}

var watchId = null;

function startLocationTracking() {
  if (!navigator.geolocation) return;
  if (watchId !== null) return;
  watchId = navigator.geolocation.watchPosition(function(pos) {
    if (!currentUser) return;
    fbUpdate('users/' + currentUser.id, {
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
      last_seen: nowTimestamp()
    }).catch(function(err) {});
  }, function(err) {
    console.warn('Geolocation error:', err.message);
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 300000 });
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
      div.innerHTML = '<input type="checkbox" id="chk_' + svc.id + '" onchange="onTeamActivityToggle(\'' + svc.id + '\')">' +
                      '<label for="chk_' + svc.id + '">' + escapeHtml(svc.name) + '</label>';
      container.appendChild(div);
    }
  });
}

function onTeamEntryTypeChange() {
  $('teamDynamicQuantities').innerHTML = '';
  onTeamGradeChange();
}

function onTeamActivityToggle(svcId) {
  var isChecked = $('chk_' + svcId).checked;
  var qtyContainer = $('teamDynamicQuantities');
  if (isChecked) {
    var svc = teamCatalogCache.find(function(s) { return s.id == svcId; });
    var div = document.createElement('div');
    div.className = 'qty-input-row';
    div.id = 'qty_row_' + svcId;
    div.innerHTML = '<label>' + escapeHtml(svc.name) + '</label>' +
                    '<input type="number" id="qty_' + svcId + '" value="1" min="1" oninput="onTeamGradeChange()">';
    qtyContainer.appendChild(div);
  } else {
    var row = $('qty_row_' + svcId);
    if (row) row.remove();
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
  teamCatalogCache.forEach(function(svc) {
    var chk = $('chk_' + svc.id);
    if (chk && chk.checked) {
      var qty = parseFloat($('qty_' + svc.id).value) || 1;
      totalQty += qty;
    }
  });
  if (type === 'miscellany') {
    totalUps = 5.6;
  } else {
    teamCatalogCache.forEach(function(svc) {
      var chk = $('chk_' + svc.id);
      if (chk && chk.checked) {
        var qty = parseFloat($('qty_' + svc.id).value) || 1;
        totalUps += qty * (svc.ups_value || 0);
      }
    });
  }
  teamCatalogCache.forEach(function(svc) {
    var chk = $('chk_' + svc.id);
    if (chk && chk.checked) {
      var qty = parseFloat($('qty_' + svc.id).value) || 1;
      totalMoney += qty * (svc.money_value || 0);
    }
  });
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
  var selectedSvcs = [];
  teamCatalogCache.forEach(function(svc) {
    var chk = $('chk_' + svc.id);
    if (chk && chk.checked) {
      var qty = parseFloat($('qty_' + svc.id).value) || 1;
      selectedSvcs.push({ svc: svc, qty: qty });
    }
  });
  if (selectedSvcs.length === 0) { showMsg('teamFormMsg', 'error', 'Selecione ao menos uma atividade'); return; }
  loading(true);
  var totalUps;
  var totalMoney = 0;
  if (type === 'miscellany') {
    totalUps = 5.6;
  } else {
    totalUps = selectedSvcs.reduce(function(sum, s) { return sum + s.qty * (s.svc.ups_value || 0); }, 0);
  }
  totalMoney = selectedSvcs.reduce(function(sum, s) { return sum + s.qty * (s.svc.money_value || 0); }, 0);
  submitNewEntry(type, nota, selectedSvcs, totalUps, totalMoney);
}

function submitNewEntry(type, grade, selectedSvcs, upsValue, moneyValue) {
  var svcNames = selectedSvcs.map(function(s) { return s.svc.name; }).join(', ');
  var totalQty = selectedSvcs.reduce(function(sum, s) { return sum + s.qty; }, 0);
  var upsPerUnit = totalQty > 0 ? upsValue / totalQty : upsValue;
  var moneyPerUnit = totalQty > 0 && moneyValue > 0 ? moneyValue / totalQty : 0;
  var typeLabel = type === 'miscellany' ? 'Miscelânea' : (type === 'emergency' ? 'Emergência' : (type === 'commercial' ? 'Comercial' : ''));
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
    created_at: nowTimestamp()
  };
  fbPush('services', serviceData).then(function(key) {
    loading(false);
    $('teamGrade').value = '';
    $('teamEntryType').value = 'miscellany';
    teamCatalogCache.forEach(function(svc) {
      var chk = $('chk_' + svc.id);
      if (chk) chk.checked = false;
    });
    $('teamDynamicQuantities').innerHTML = '';
    toast('Registro adicionado!', 'success');
    refreshTeamView();
    return fbUpdate('users/' + currentUser.id, { last_seen: nowTimestamp() });
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
    return fbUpdate('users/' + currentUser.id, { last_seen: nowTimestamp() });
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
    toast('Servi\u00E7o removido', 'info');
    refreshTeamView();
  }).catch(function(err) {
    loading(false);
    toast('Erro: ' + err.message, 'error');
  });
}

// ===== DATA FUNCTIONS =====
function getTeamSummary(userId, startDate, endDate) {
  return Promise.all([fbOnce('services'), fbOnce('users/' + userId)]).then(function(results) {
    var allServices = results[0];
    var userData = results[1];
    var arr = toArray(allServices);
    var filtered = arr.filter(function(s) {
      return s.user_id === userId && s.date >= startDate && s.date <= endDate;
    });
    var services = filtered.map(function(s) { return formatService(s); });
    var totalUps = services.reduce(function(sum, sv) { return sum + sv.upsValue; }, 0);
    var totalMoney = services.reduce(function(sum, sv) { return sum + (sv.totalMoney || 0); }, 0);
    var classInfo = getClassification(totalUps);
    return {
      userId: userId, startDate: startDate, endDate: endDate,
      goal_money: (userData && userData.goal_money) || 0,
      services: services, totalUps: totalUps, totalMoney: totalMoney,
      class: classInfo.class, color: classInfo.color, count: services.length
    };
  });
}

function getAllTeamsSummaryForPeriod(startDate, endDate) {
  return Promise.all([fbOnce('users'), fbOnce('services')]).then(function(results) {
    var users = toArray(results[0]);
    var allServices = toArray(results[1]);
    return users.filter(function(u) { return u.role !== 'admin'; }).map(function(user) {
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
  Promise.all([fbOnce('services'), fbOnce('users'), fbOnce('catalog_services')]).then(function(results) {
    var allServices = toArray(results[0]);
    var users = toArray(results[1]);
    var catalog = toArray(results[2]);
    var filtered = allServices.filter(function(s) { return s.date >= start && s.date <= end; });

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
    date: s.date,
    type: s.type || 'catalog',
    activities: s.activities || []
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
  celebratedTeams = new Set();
  showView('loginView');
  toast('Sessão encerrada', 'info');
}

// ===== ADMIN VIEW =====
function initAdminView() {
  var today = todayStr();
  $('adminStartDate').value = today;
  $('adminEndDate').value = today;
  $('adminDate').textContent = formatDateBr(today);
  showView('adminView');
  initTabs();
  loadAllAdminData();
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(loadAllAdminData, 30000);
  $('adminStartDate').addEventListener('change', loadAllAdminData);
  $('adminEndDate').addEventListener('change', loadAllAdminData);
  setTimeout(captureAdminLocation, 500);
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
    });
  }
}

function loadAllAdminData() {
  var start = $('adminStartDate').value;
  var end = $('adminEndDate').value;
  fbOnce('rules').then(function(rules) {
    rulesCache = toArray(rules).map(function(r) {
      return { id: r.id, class: r.class, minUps: r.min_ups, maxUps: r.max_ups, color: r.color };
    });
    loadPainel(start, end);
  });
  fbOnce('users').then(function(users) {
    userCache = toArray(users);
  });
  loadTeamsList();
  loadCatalogList();
  loadMapData(start, end);
  loadStatistics();
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
  fbOnce('users').then(function(users) {
    var arr = toArray(users);
    renderTeamsList(arr);
  });
}

function renderTeamsList(users) {
  var container = $('teamsList');
  var teams = users.filter(function(u) { return u.role !== 'admin'; });
  if (teams.length === 0) {
    container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">groups</span><p>Nenhuma equipe cadastrada</p></div>';
    return;
  }
  var html = '<div class="table-wrap"><table><thead><tr><th>ID</th><th>Nome</th><th>Supervisor</th><th>Meta R$</th><th>Status</th><th>Função</th><th>Localização</th><th>Ações</th></tr></thead><tbody>';
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
    html += '<tr>' +
      '<td style="font-weight:600;color:var(--text-muted);">#' + t.id.slice(-6) + '</td>' +
      '<td><strong>' + escapeHtml(t.username) + '</strong></td>' +
      '<td>' + supDisplay + '</td>' +
      '<td style="color:var(--money);font-weight:600;">' + goalDisplay + '</td>' +
      '<td>' + statusHtml + '</td>' +
      '<td><span style="background:var(--primary-bg);color:var(--primary);padding:2px 10px;border-radius:20px;font-size:12px;font-weight:600;">' + t.role + '</span></td>' +
      '<td>' + locDisplay + '</td>' +
      '<td class="actions">' +
      '<button class="btn btn-sm btn-outline" onclick="editTeam(\'' + t.id + '\')"><span class="material-symbols-outlined">edit</span> Editar</button>' +
      '<button class="btn btn-sm btn-danger" onclick="deleteTeam(\'' + t.id + '\')"><span class="material-symbols-outlined">delete</span></button>' +
      '</td></tr>';
  }
  html += '</tbody></table></div>';
  container.innerHTML = html;
}

function captureLocationForTeam() {
  captureAdminLocation();
}

function createTeam() {
  var name = $('newTeamName').value.trim();
  var pass = $('newTeamPass').value.trim();
  var supervisor = $('newTeamSupervisor').value.trim();
  var goalRaw = $('newTeamGoal').value;
  var goalMoney = parseFloat(goalRaw) || 0;
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
    var userData = {
      username: name, password: pass, role: 'equipe',
      supervisor: supervisor || '',
      goal_money: goalMoney,
      latitude: String(adminLocation.lat),
      longitude: String(adminLocation.lng),
      address: adminAddress || '',
      last_seen: nowTimestamp(),
      created_at: nowTimestamp(),
      registered_by: currentUser ? currentUser.id : '',
      registered_at: nowTimestamp()
    };
    return fbPush('users', userData).then(function(key) {
      loading(false);
      $('newTeamName').value = '';
      $('newTeamPass').value = '';
      $('newTeamSupervisor').value = '';
      $('newTeamGoal').value = '';
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
  if (!confirm('Excluir esta equipe?')) return;
  loading(true);
  fbRemove('users/' + id).then(function() {
    loading(false);
    toast('Equipe excluída', 'info');
    loadAllAdminData();
  }).catch(function(err) {
    loading(false);
    toast('Erro: ' + err.message, 'error');
  });
}

function showResetPass(id) {
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
    $('editTeamSupervisor').value = user.supervisor || '';
    $('editTeamGoal').value = user.goal_money > 0 ? user.goal_money : '';
    $('editTeamPass').value = '';
    clearMsg('editTeamMsg');
    $('editTeamModal').style.display = 'flex';
  }).catch(function(err) {
    loading(false);
    toast('Erro: ' + err.message, 'error');
  });
}

function saveEditTeam() {
  var id = $('editTeamId').value;
  var name = $('editTeamName').value.trim();
  var supervisor = $('editTeamSupervisor').value.trim();
  var goalRaw = $('editTeamGoal').value;
  var goalMoney = parseFloat(goalRaw) || 0;
  var newPass = $('editTeamPass').value.trim();

  if (!name) { showMsg('editTeamMsg', 'error', 'O nome da equipe é obrigatório'); return; }
  clearMsg('editTeamMsg');

  var updateData = {
    username: name,
    supervisor: supervisor || '',
    goal_money: goalMoney
  };

  if (newPass && newPass.length >= 3) {
    updateData.password = newPass;
  }

  loading(true);
  fbUpdate('users/' + id, updateData).then(function() {
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
  fbOnce('catalog_services').then(function(services) {
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
  var start = $('adminStartDate').value;
  var end = $('adminEndDate').value;
  if (!start || !end) { toast('Selecione o período', 'error'); return; }
  loading(true);
  Promise.all([fbOnce('services'), fbOnce('users')]).then(function(results) {
    var allServices = toArray(results[0]);
    var users = toArray(results[1]);
    var userMap = {};
    users.forEach(function(u) { userMap[u.id] = u.username; });
    var filtered = allServices.filter(function(s) {
      return s.date >= start && s.date <= end;
    }).map(function(s) {
      var user = users.find(function(u) { return u.id === s.user_id; });
      return {
        id: s.id, equipe: userMap[s.user_id] || 'Desconhecido',
        servico: s.service_name, ups: s.ups_value, quantidade: s.quantity,
        valor_total: s.total_money, nota: s.grade, data: s.date,
        latitude: s.latitude, longitude: s.longitude,
        endereco_equipe: (user && user.address) || ''
      };
    });
    loading(false);
    if (!filtered || filtered.length === 0) { toast('Nenhum dado para exportar no período', 'info'); return; }
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
    link.setAttribute('download', 'exportacao_ups_' + start + '_to_' + end + '.csv');
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast('Exportação concluída!', 'success');
  }).catch(function(err) {
    loading(false);
    toast('Erro ao exportar: ' + err.message, 'error');
  });
}

// --- Regras ---
function addRule() {
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
