/* =====================================================================
   RapiPréstamos · SEGUIMIENTO DE TAREAS — Servidor (Google Apps Script)
   ---------------------------------------------------------------------
   Va pegado en una hoja de Google: Extensiones → Apps Script → Code.gs,
   y se publica como "Aplicación web" (Ejecutar como: Yo · Acceso: Cualquier usuario).

   Este archivo tiene dos partes:
     1) LÓGICA CENTRAL: es exactamente la misma que trae index.html (quién ve qué, tareas,
        carpetas, MCI, tiempos, recurrentes, seguimientos, notificaciones y usuarios).
        Si se cambia en uno, hay que copiarla igual en el otro.
     2) ALMACENAMIENTO: guarda todo en las pestañas de esta hoja y los adjuntos en Google Drive.

   Seguridad:
     · Contraseñas cifradas (sal + SHA-256 repetido). En la hoja nunca queda la contraseña.
     · 5 intentos fallidos → 15 minutos de espera.
     · La sesión dura 30 días desde el último uso; al cambiar o asignar una contraseña,
       o al desactivar a alguien, se cierran sus otras sesiones.
   ===================================================================== */

var AJUSTES = {
  SESION_DIAS: 30,
  ITERACIONES: 1000,             // repeticiones del SHA-256 al cifrar contraseñas
  MAX_ARCHIVO_MB: 10,
  CORREO_RESUMEN_DIARIO: true,   // correo diario con avisos de vencimientos (lo envía la tarea de las 7 a. m.)
  CARPETA_ADJUNTOS: 'Seguimiento de tareas · adjuntos'
};

/* ======================= 1) LÓGICA CENTRAL (copiada de index.html) ======================= */
/* ===================================================================
   Seguimiento de tareas — LÓGICA CENTRAL (compartida)
   Esta misma lógica corre en el servidor (Google Apps Script) y en el
   modo demo del navegador. Aquí se decide QUIÉN PUEDE VER Y HACER QUÉ.
   =================================================================== */
var MYA_CORE_VERSION = '3.0';

var MYA_SCHEMA = {
  Usuarios: ['usuario', 'nombre', 'cargo', 'area', 'jefe', 'puedeVer', 'rol', 'activo', 'salt', 'hash', 'creado', 'email', 'esAdmin', 'debeCambiar'],
  Carpetas: ['id', 'dueno', 'padreId', 'nombre', 'tipo', 'color', 'orden', 'creado', 'creadoPor', 'eliminado'],
  Tareas: ['id', 'dueno', 'carpetaId', 'titulo', 'descripcion', 'prioridad', 'estatus', 'fechaAsignacion',
    'fechaTentativa', 'fechaReal', 'asignadoPor', 'creadoPor', 'creado', 'actualizado', 'actualizadoPor',
    'comentarios', 'eliminado', 'mciId', 'enfoque', 'tipo', 'avisos', 'avisosEnviados', 'recurrenciaId', 'checklist'],
  Adjuntos: ['id', 'tareaId', 'dueno', 'nombre', 'mime', 'tamano', 'ref', 'subidoPor', 'fecha', 'nota', 'eliminado'],
  Notificaciones: ['id', 'para', 'de', 'tareaId', 'dueno', 'tipo', 'mensaje', 'fecha', 'leida'],
  Historial: ['fecha', 'usuario', 'accion', 'entidad', 'entidadId', 'dueno', 'campo', 'anterior', 'nuevo'],
  MCI: ['id', 'dueno', 'titulo', 'descripcion', 'indicador', 'fechaLimite', 'estatus', 'creado', 'actualizado', 'eliminado'],
  Tiempos: ['id', 'tareaId', 'dueno', 'usuario', 'inicio', 'inicioMs', 'fin', 'segundos', 'fuente', 'nota', 'eliminado'],
  Seguimientos: ['id', 'dueno', 'titulo', 'responsable', 'responsableNombre', 'queSeguir', 'proximaFecha', 'estatus', 'compartido',
    'tareaId', 'bitacora', 'avisado', 'creado', 'actualizado', 'eliminado'],
  Recurrentes: ['id', 'dueno', 'titulo', 'descripcion', 'carpetaId', 'prioridad', 'tipo', 'mciId', 'enfoque', 'frecuencia', 'dia', 'ajuste',
    'inicio', 'fin', 'avisos', 'plantilla', 'ultimaGenerada', 'activo', 'creado', 'eliminado', 'intervalo']
};

var MYA_ESTATUS = ['Pendiente', 'En progreso', 'Esperando respuesta', 'En revisión', 'Pausado', 'Completado', 'Cancelado'];
var MYA_PRIORIDAD = ['Crítica', 'Alta', 'Media', 'Baja'];
var MYA_TIPOS = ['Empresa', 'Proyecto', 'Subproyecto', 'Área', 'Otro'];
var MYA_ROLES = ['colaborador', 'jefe', 'ceo'];
var MYA_COMENTARIO_TIPOS = ['comentario', 'cambios', 'aprobado'];
var MYA_MAX_ARCHIVO_MB = 10;
/* v3: enfoque del tiempo — ¿avanza un objetivo (MCI) o es del día a día? */
var MYA_ENFOQUE = ['MCI', 'Rutina', 'Fuego', 'Esporádica'];
var MYA_MCI_ESTATUS = ['Activa', 'Cumplida', 'Pausada', 'Cancelada'];
var MYA_SEG_ESTATUS = ['Abierto', 'En espera', 'Cerrado'];
var MYA_FRECUENCIAS = ['diaria', 'semanal', 'mensual', 'anual'];
var MYA_AJUSTES = ['ninguno', 'anterior', 'siguiente'];

function createMyaCore(store) {
  function err(msg) { var e = new Error(msg); e.userFacing = true; return e; }
  function str(v) { return v === null || v === undefined ? '' : String(v).trim(); }
  function low(v) { return str(v).toLowerCase(); }
  function isTrue(v) { var s = low(v); return v === true || v === 1 || s === 'true' || s === '1' || s === 'si' || s === 'sí'; }
  function isDate(s) { return s === '' || /^\d{4}-\d{2}-\d{2}$/.test(s); }
  function clip(s, n) { s = str(s); return s.length > n ? s.slice(0, n) : s; }
  function copy(o) { var c = {}; for (var k in o) c[k] = o[k]; return c; }

  function users() { return store.rows('Usuarios'); }
  function userBy(u) {
    u = low(u); var all = users();
    for (var i = 0; i < all.length; i++) if (low(all[i].usuario) === u) return all[i];
    return null;
  }
  function nameOf(u) { var x = userBy(u); return x ? (x.nombre || x.usuario) : u; }
  function isAdmin(u) { return !!u && (isTrue(u.esAdmin) || u.rol === 'admin'); }
  /* Rol que define la VISIBILIDAD:
       colaborador → solo su propio tablero
       jefe        → el suyo + sus colaboradores directos (+ accesos adicionales)
       ceo         → el suyo + quienes le reportan directo (los jefes) (+ adicionales)
     Los valores antiguos ('admin', 'usuario') se interpretan para no romper datos previos. */
  function roleOf(u) {
    if (!u) return 'colaborador';
    if (MYA_ROLES.indexOf(u.rol) >= 0) return u.rol;
    if (u.rol === 'subordinado') return 'colaborador'; // nombre anterior del rol
    var hasReports = users().some(function (x) { return low(x.jefe) === low(u.usuario) && isTrue(x.activo); });
    return hasReports ? 'jefe' : 'colaborador';
  }
  function publicUser(u) {
    return { usuario: u.usuario, nombre: u.nombre, cargo: u.cargo, area: u.area, jefe: u.jefe, rol: roleOf(u), esAdmin: isAdmin(u) };
  }

  /* ---------- REGLA DE ACCESO (el "bloqueo") ----------
     Ser administrador(a) NO da acceso a tableros ajenos: solo permite gestionar usuarios. */
  function visibleOwners(me) {
    var out = {}; out[me.usuario] = true;
    if (roleOf(me) === 'colaborador') return out;
    var extras = str(me.puedeVer).split(/[,;\n]/).map(function (s) { return s.trim(); }).filter(String);
    users().forEach(function (u) {
      if (!isTrue(u.activo)) return;
      if (low(u.jefe) === low(me.usuario)) out[u.usuario] = true;
      extras.forEach(function (x) {
        if (low(x).indexOf('area:') === 0) { if (low(u.area) === low(x.slice(5))) out[u.usuario] = true; }
        else if (low(x) === low(u.usuario)) out[u.usuario] = true;
      });
    });
    return out;
  }
  function canSee(me, owner) { return !!visibleOwners(me)[owner]; }

  function sessionUser(token) {
    var u = token ? store.sessionGet(token) : null;
    if (!u) throw err('SESION_EXPIRADA');
    var user = userBy(u);
    if (!user || !isTrue(user.activo)) throw err('SESION_EXPIRADA');
    store.sessionPut(token, user.usuario);
    return user;
  }

  function log(me, accion, entidad, id, dueno, campo, anterior, nuevo) {
    store.insert('Historial', {
      fecha: store.now(), usuario: me.usuario, accion: accion, entidad: entidad, entidadId: id, dueno: dueno,
      campo: campo || '', anterior: clip(anterior, 500), nuevo: clip(nuevo, 500)
    });
  }

  function liveFolders() { return store.rows('Carpetas').filter(function (f) { return !isTrue(f.eliminado); }); }
  function liveTasks() { return store.rows('Tareas').filter(function (t) { return !isTrue(t.eliminado); }); }
  function liveFiles() { return store.rows('Adjuntos').filter(function (a) { return !isTrue(a.eliminado); }); }
  function findBy(list, id) { for (var i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) return list[i]; return null; }
  function parseComments(t) { try { return t.comentarios ? JSON.parse(t.comentarios) : []; } catch (e) { return []; } }
  function taskFor(me, id) {
    var t = findBy(liveTasks(), id);
    if (!t) throw err('La tarea no existe o fue eliminada.');
    if (!canSee(me, t.dueno)) throw err('No tienes acceso a esta tarea.');
    return t;
  }

  /* ---------- v3: utilidades de fechas, MCI, tiempos, seguimientos, recurrentes ---------- */
  function dms(iso) { return Date.parse(iso + 'T00:00:00Z'); }
  function addD(iso, n) { return new Date(dms(iso) + n * 864e5).toISOString().slice(0, 10); }
  function diffD(a, b) { return Math.round((dms(a) - dms(b)) / 864e5); }
  function lastDay(y, m0) { return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate(); }
  var MES_CORTO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  var DIA_CORTO = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  function fechaCorta(iso) { var d = new Date(dms(iso)); return DIA_CORTO[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MES_CORTO[d.getUTCMonth()]; }
  function parseJSON(s, def) { try { return s ? JSON.parse(s) : def; } catch (e) { return def; } }
  function liveRows(name) { return store.rows(name).filter(function (r) { return !isTrue(r.eliminado); }); }
  /* Avisos: días antes de la fecha (0 = el mismo día) + qué hacer si se vence:
     V = avisar una vez · VD = avisar cada día hasta completarla. Ej.: "7,1,0,V" */
  function cleanAvisos(v) {
    var seen = {}, venc = '';
    var nums = str(v).split(/[,;\s]+/).filter(function (x) {
      var u = x.toUpperCase();
      if (u === 'V' || u === 'VD') { venc = u; return false; }
      return true;
    }).map(function (x) { return parseInt(x, 10); })
      .filter(function (n) { if (isNaN(n) || n < 0 || n > 90 || seen[n]) return false; seen[n] = 1; return true; })
      .sort(function (a, b) { return b - a; });
    if (venc) nums.push(venc);
    return nums.join(',');
  }
  function cleanChecklist(c) {
    if (!c || typeof c !== 'object') return '';
    var cols = (c.columnas || []).map(function (x) { return clip(x, 40); }).filter(String).slice(0, 6);
    var out = {
      columnas: cols,
      pasos: (c.pasos || []).slice(0, 30).map(function (p) {
        return typeof p === 'string' ? { t: clip(p, 200), ok: false } : { t: clip(p.t, 200), ok: !!p.ok, por: clip(p.por, 30), fecha: clip(p.fecha, 20) };
      }).filter(function (p) { return p.t; }),
      items: (c.items || []).slice(0, 60).map(function (it) {
        if (typeof it === 'string') it = { t: it };
        var m = (it.marcas || []).slice(0, cols.length).map(function (x) { return !!x; });
        while (m.length < cols.length) m.push(false);
        return { t: clip(it.t, 120), marcas: m, nota: clip(it.nota, 200) };
      }).filter(function (it) { return it.t; })
    };
    if (!out.pasos.length && !out.items.length) return '';
    return JSON.stringify(out);
  }
  function runningFor(usuario) {
    var l = liveRows('Tiempos'); for (var i = 0; i < l.length; i++) if (l[i].usuario === usuario && !str(l[i].fin)) return l[i];
    return null;
  }
  function stopEntry(e) {
    var u = copy(e), ms = store.nowMs();
    u.fin = store.now(); u.segundos = String(Math.max(0, Math.round((ms - Number(e.inicioMs)) / 1000)));
    store.update('Tiempos', 'id', e.id, u); return u;
  }

  /* Recurrencias: ¿la fecha "base" corresponde a la regla? (antes del ajuste por fin de semana) */
  function intervalOf(r) {
    var n = parseInt(r.intervalo, 10);
    if (r.frecuencia === 'trimestral') return 3; // valor antiguo
    return n >= 1 && n <= 24 ? n : 1;
  }
  function isBaseDate(r, iso) {
    var d = new Date(dms(iso)), y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
    var ini = new Date(dms(r.inicio)), n = intervalOf(r), wd = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
    if (r.frecuencia === 'diaria') {
      if (str(r.dia) === 'habiles' && wd > 5) return false;
      return diffD(iso, r.inicio) % n === 0;
    }
    if (r.frecuencia === 'semanal') {
      if (!str(r.dia).split(',').some(function (x) { return parseInt(x, 10) === wd; })) return false;
      var iniWd = ini.getUTCDay() === 0 ? 7 : ini.getUTCDay();
      var weeks = Math.floor(diffD(addD(iso, 1 - wd), addD(r.inicio, 1 - iniWd)) / 7);
      return weeks % n === 0;
    }
    var months = (y - ini.getUTCFullYear()) * 12 + (m - ini.getUTCMonth());
    if (r.frecuencia === 'anual') { if (m !== ini.getUTCMonth() || (months / 12) % n !== 0) return false; }
    else if (months % n !== 0) return false;
    var ld = lastDay(y, m);
    return str(r.dia).split(',').some(function (x) { var k = parseInt(x, 10); return !isNaN(k) && (k === day || (k > ld && day === ld)); });
  }
  function adjustDate(r, iso) {
    var wd = new Date(dms(iso)).getUTCDay();
    if (r.ajuste === 'anterior') { if (wd === 6) return addD(iso, -1); if (wd === 0) return addD(iso, -2); }
    if (r.ajuste === 'siguiente') { if (wd === 6) return addD(iso, 2); if (wd === 0) return addD(iso, 1); }
    return iso;
  }
  function periodLabel(r, iso) {
    var d = new Date(dms(iso));
    if (r.frecuencia === 'semanal' || r.frecuencia === 'diaria') return fechaCorta(iso);
    if ((r.frecuencia === 'mensual' || r.frecuencia === 'trimestral') && str(r.dia).indexOf(',') < 0) return MES_CORTO[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
    if (r.frecuencia === 'anual') return String(d.getUTCFullYear());
    return d.getUTCDate() + ' ' + MES_CORTO[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }
  function plantillaToChecklist(p) {
    var t = parseJSON(p, null); if (!t) return '';
    return cleanChecklist({ columnas: t.columnas || [], pasos: (t.pasos || []).map(function (x) { return { t: x, ok: false }; }),
      items: (t.items || []).map(function (x) { return { t: x }; }) });
  }
  /* Crea las tareas de cada ocurrencia hasta 31 días adelante (para que salgan los avisos a tiempo). */
  function generateRecurring(owner) {
    var today = store.today(), made = 0;
    liveRows('Recurrentes').forEach(function (r) {
      if (owner && r.dueno !== owner) return;
      if (!isTrue(r.activo) || !r.inicio) return;
      var from = r.ultimaGenerada ? addD(r.ultimaGenerada, 1) : r.inicio;
      if (from < addD(today, -62)) from = addD(today, -62);
      if (from < r.inicio) from = r.inicio;
      var to = addD(today, 31); if (r.fin && r.fin < to) to = r.fin;
      if (from > to) return;
      for (var d = from, g = 0; d <= to && g < 400; d = addD(d, 1), g++) {
        if (!isBaseDate(r, d)) continue;
        var fecha = adjustDate(r, d);
        var nt = {
          id: 'T' + store.uuid().slice(0, 10), dueno: r.dueno, carpetaId: r.carpetaId, titulo: clip(r.titulo + ' · ' + periodLabel(r, d), 200),
          descripcion: r.descripcion, prioridad: r.prioridad || 'Alta', estatus: 'Pendiente', fechaAsignacion: today, fechaTentativa: fecha,
          fechaReal: '', asignadoPor: '', creadoPor: r.dueno, creado: store.now(), actualizado: store.now(), actualizadoPor: r.dueno,
          comentarios: '[]', eliminado: 'FALSE', mciId: r.mciId, enfoque: r.enfoque || 'Rutina', tipo: r.tipo, avisos: r.avisos,
          avisosEnviados: '', recurrenciaId: r.id, checklist: plantillaToChecklist(r.plantilla)
        };
        store.insert('Tareas', nt); made++;
      }
      var u = copy(r); u.ultimaGenerada = to; store.update('Recurrentes', 'id', r.id, u);
    });
    return made;
  }

  /* Alertas de calendario: 7 días antes, el día anterior, el día (lo que se configure) y una vez si se vence.
     p = aviso en la página, c = aviso por correo (se controlan por separado). */
  function runAlerts(opts) {
    opts = opts || {};
    var today = store.today(), mails = {};
    function addMail(u, line) { (mails[u] = mails[u] || []).push(line); }
    liveTasks().forEach(function (t) {
      if (opts.owner && t.dueno !== opts.owner) return;
      if (!str(t.avisos) || !t.fechaTentativa || t.estatus === 'Completado' || t.estatus === 'Cancelado') return;
      var sent = str(t.avisosEnviados).split(',').filter(String), changed = false;
      var av = cleanAvisos(t.avisos).split(',').filter(String);
      var venc = av.indexOf('VD') >= 0 ? 'VD' : (av.indexOf('V') >= 0 ? 'V' : '');
      var offs = av.filter(function (x) { return x !== 'V' && x !== 'VD'; }).map(Number);
      var dLeft = diffD(t.fechaTentativa, today);
      ['p', 'c'].forEach(function (ch) {
        if (ch === 'c' && !opts.mail) return;
        var due = offs.filter(function (o) { return dLeft <= o && dLeft >= 0 && sent.indexOf(ch + o) < 0; });
        var msg = '';
        if (due.length) {
          due.forEach(function (o) { sent.push(ch + o); }); changed = true;
          msg = dLeft === 0 ? 'vence HOY' : (dLeft === 1 ? 'vence mañana (' + fechaCorta(t.fechaTentativa) + ')' : 'vence en ' + dLeft + ' días (' + fechaCorta(t.fechaTentativa) + ')');
        } else if (dLeft < 0 && venc === 'V' && sent.indexOf(ch + 'V') < 0) {
          sent.push(ch + 'V'); changed = true; msg = 'está VENCIDA desde el ' + fechaCorta(t.fechaTentativa) + ' y sigue abierta';
        } else if (dLeft < 0 && venc === 'VD' && sent.indexOf(ch + 'D' + today) < 0) {
          sent = sent.filter(function (x) { return x.indexOf(ch + 'D') !== 0; });
          sent.push(ch + 'D' + today); changed = true;
          msg = 'sigue abierta y está vencida hace ' + (-dLeft) + ' día' + (dLeft === -1 ? '' : 's') + ' (desde el ' + fechaCorta(t.fechaTentativa) + ')';
        }
        if (!msg) return;
        var texto = '«' + t.titulo + '» ' + msg;
        if (ch === 'p') store.insert('Notificaciones', { id: 'N' + store.uuid().slice(0, 12), para: t.dueno, de: 'sistema', tareaId: t.id, dueno: t.dueno,
          tipo: 'recordatorio', mensaje: clip('Recordatorio: ' + texto, 600), fecha: store.now(), leida: 'FALSE' });
        else addMail(t.dueno, texto);
      });
      if (changed) { var u = copy(t); u.avisosEnviados = sent.join(','); store.update('Tareas', 'id', t.id, u); }
    });
    liveRows('Seguimientos').forEach(function (s) {
      if (opts.owner && s.dueno !== opts.owner) return;
      if (s.estatus === 'Cerrado' || !s.proximaFecha || s.proximaFecha > today) return;
      var key = s.proximaFecha + (opts.mail ? '|c' : '');
      var av = str(s.avisado).split(',');
      var resp = s.responsable ? nameOf(s.responsable) : (s.responsableNombre || 'sin responsable');
      var texto = 'Seguimiento con ' + resp + ': «' + s.titulo + '»' + (s.proximaFecha < today ? ' (pendiente desde el ' + fechaCorta(s.proximaFecha) + ')' : ' es HOY') + (s.queSeguir ? ' — ' + s.queSeguir : '');
      var changed = false;
      if (av.indexOf(s.proximaFecha) < 0) {
        av.push(s.proximaFecha); changed = true;
        store.insert('Notificaciones', { id: 'N' + store.uuid().slice(0, 12), para: s.dueno, de: 'sistema', tareaId: s.id, dueno: s.dueno,
          tipo: 'seguimiento', mensaje: clip(texto, 600), fecha: store.now(), leida: 'FALSE' });
      }
      if (opts.mail && av.indexOf(key) < 0) { av.push(key); changed = true; addMail(s.dueno, texto); }
      if (changed) { var u = copy(s); u.avisado = av.filter(String).slice(-6).join(','); store.update('Seguimientos', 'id', s.id, u); }
    });
    var enviados = 0;
    if (opts.mail && store.sendAlertMail) {
      Object.keys(mails).forEach(function (usr) {
        var x = userBy(usr); if (!x || !isTrue(x.activo) || !str(x.email)) return;
        try { store.sendAlertMail(str(x.email), x.nombre, mails[usr]); enviados++; } catch (e) { }
      });
    }
    return { correos: enviados };
  }

  /* ---------- Notificaciones ---------- */
  var PRI_RANK = { 'Crítica': 0, 'Alta': 1, 'Media': 2, 'Baja': 3 };
  function participants(task) {
    var set = {}; set[task.dueno] = true;
    if (task.asignadoPor) set[task.asignadoPor] = true;
    var owner = userBy(task.dueno); if (owner && owner.jefe) set[low(owner.jefe)] = true;
    return Object.keys(set).filter(function (u) { var x = userBy(u); return x && isTrue(x.activo) && canSee(x, task.dueno); });
  }
  var OWNER_TO_BOSS = { fecha: 1, completada: 1, adjunto: 1, comentario: 1 };
  function notify(me, task, tipo, mensaje, emailToOwner) {
    var rec = participants(task).filter(function (u) { return u !== me.usuario; });
    if (me.usuario === task.dueno && !OWNER_TO_BOSS[tipo]) rec = [];
    rec.forEach(function (u) {
      store.insert('Notificaciones', {
        id: 'N' + store.uuid().slice(0, 12), para: u, de: me.usuario, tareaId: task.id, dueno: task.dueno,
        tipo: tipo, mensaje: clip(mensaje, 600), fecha: store.now(), leida: 'FALSE'
      });
    });
    if (emailToOwner && me.usuario !== task.dueno && store.sendMail) { // solo si el servidor tiene correo configurado (desactivado)
      var o = userBy(task.dueno);
      if (o && str(o.email)) { try { store.sendMail(str(o.email), 'Cambio en tus tareas: ' + task.titulo, mensaje); } catch (e) { } }
    }
  }

  var actions = {
    login: function (req) {
      var usuario = low(req.usuario);
      if (store.failCount(usuario) >= 5) throw err('Demasiados intentos fallidos. Espera 15 minutos e inténtalo de nuevo.');
      var u = userBy(usuario);
      if (u && isTrue(u.activo) && !u.hash) throw err('CREAR_CLAVE');
      if (!u || !isTrue(u.activo) || !u.hash || store.hash(u.salt, str(req.password)) !== u.hash) {
        store.failInc(usuario);
        throw err('Usuario o contraseña incorrectos.');
      }
      store.failReset(usuario);
      var token = store.uuid() + store.uuid();
      store.sessionPut(token, u.usuario);
      log(u, 'login', 'Sesión', '', u.usuario, '', '', '');
      return { token: token, me: publicUser(u), debeCambiar: isTrue(u.debeCambiar) };
    },

    /* ---------- Configuración inicial (sin contraseñas en el código) ---------- */
    setupStatus: function () { return { necesitaConfiguracion: users().length === 0 }; },
    setupAdmin: function (req) {
      if (users().length) throw err('El sistema ya está configurado.');
      var usuario = low(req.usuario), clave = str(req.password);
      if (!/^[a-z0-9._-]{3,30}$/.test(usuario)) throw err('Usuario no válido (3-30 letras minúsculas, números, punto o guion).');
      if (!clip(req.nombre, 80)) throw err('Escribe tu nombre completo.');
      if (clave.length < 8) throw err('La contraseña debe tener al menos 8 caracteres.');
      var salt = store.uuid();
      var row = { usuario: usuario, nombre: clip(req.nombre, 80), cargo: clip(req.cargo, 80), area: clip(req.area, 60), jefe: '', puedeVer: '',
        rol: 'colaborador', activo: 'TRUE', salt: salt, hash: store.hash(salt, clave), creado: store.now(), email: '', esAdmin: 'TRUE', debeCambiar: 'FALSE' };
      store.insert('Usuarios', row);
      log(row, 'configuración inicial', 'Usuario', usuario, usuario, '', '', 'cuenta de administración creada');
      return { ok: true };
    },
    /* Si un usuario quedó sin contraseña (restablecida desde Apps Script), la crea al entrar */
    createPassword: function (req) {
      var u = userBy(req.usuario), clave = str(req.password);
      if (!u || !isTrue(u.activo) || u.hash) throw err('No disponible para este usuario.');
      if (clave.length < 8) throw err('La contraseña debe tener al menos 8 caracteres.');
      var upd = copy(u); upd.salt = store.uuid(); upd.hash = store.hash(upd.salt, clave); upd.debeCambiar = 'FALSE';
      store.update('Usuarios', 'usuario', u.usuario, upd);
      log(u, 'crear contraseña', 'Usuario', u.usuario, u.usuario, '', '', '');
      return { ok: true };
    },

    logout: function (req) { if (req.token) store.sessionDel(req.token); return { ok: true }; },

    data: function (req, me) {
      try { generateRecurring(me.usuario); runAlerts({ owner: me.usuario }); } catch (e) { }
      var vis = visibleOwners(me);
      var people = users().filter(function (u) { return vis[u.usuario] && isTrue(u.activo); }).map(function (u) {
        var p = publicUser(u); p.esYo = u.usuario === me.usuario; return p;
      });
      var tasks = liveTasks().filter(function (t) { return vis[t.dueno]; });
      var taskIds = {}; tasks.forEach(function (t) { taskIds[t.id] = true; });
      return {
        me: publicUser(me), people: people,
        folders: liveFolders().filter(function (f) { return vis[f.dueno]; }),
        tasks: tasks.map(function (t) { var o = copy(t); o.comentarios = parseComments(t); o.checklist = parseJSON(t.checklist, null); delete o.avisosEnviados; return o; }),
        files: liveFiles().filter(function (a) { return taskIds[a.tareaId]; }).map(function (a) { var o = copy(a); delete o.ref; return o; }),
        notifs: store.rows('Notificaciones').filter(function (n) { return n.para === me.usuario && (vis[n.dueno] || n.tipo === 'seguimiento'); }).slice(-80).reverse(),
        mcis: liveRows('MCI').filter(function (m) { return vis[m.dueno]; }),
        tiempos: liveRows('Tiempos').filter(function (x) { return vis[x.dueno] && taskIds[x.tareaId]; }),
        seguimientos: liveRows('Seguimientos').filter(function (s) { return s.dueno === me.usuario || (isTrue(s.compartido) && s.responsable === me.usuario); })
          .map(function (s) {
            var o = copy(s); o.bitacora = parseJSON(s.bitacora, []); delete o.avisado;
            var lt = s.tareaId ? findBy(liveTasks(), s.tareaId) : null;
            o.tarea = lt && (canSee(me, lt.dueno)) ? { id: lt.id, titulo: lt.titulo, estatus: lt.estatus, fechaTentativa: lt.fechaTentativa, dueno: lt.dueno } : null;
            return o;
          }),
        recurrentes: liveRows('Recurrentes').filter(function (r) { return r.dueno === me.usuario; }).map(function (r) { var o = copy(r); o.plantilla = parseJSON(r.plantilla, null); return o; }),
        today: store.today(), serverMs: store.nowMs()
      };
    },

    saveFolder: function (req, me) {
      var f = req.folder || {};
      var nombre = clip(f.nombre, 80);
      if (!nombre) throw err('La carpeta necesita un nombre.');
      var tipo = MYA_TIPOS.indexOf(f.tipo) >= 0 ? f.tipo : 'Proyecto';
      var all = liveFolders();
      var padreId = str(f.padreId);
      if (padreId) { var p = findBy(all, padreId); if (!p || p.dueno !== me.usuario) throw err('Carpeta superior no válida.'); }
      if (f.id) {
        var cur = findBy(all, f.id);
        if (!cur) throw err('La carpeta no existe.');
        if (cur.dueno !== me.usuario) throw err('Solo la dueña o el dueño del tablero organiza sus carpetas.');
        var x = padreId;
        while (x) { if (x === cur.id) throw err('Una carpeta no puede ir dentro de sí misma.'); var px = findBy(all, x); x = px ? str(px.padreId) : ''; }
        var upd = copy(cur);
        upd.nombre = nombre; upd.tipo = tipo; upd.padreId = padreId; upd.color = clip(f.color, 20);
        store.update('Carpetas', 'id', cur.id, upd);
        if (cur.nombre !== nombre) log(me, 'editar', 'Carpeta', cur.id, me.usuario, 'nombre', cur.nombre, nombre);
        return { folder: upd };
      }
      var nf = {
        id: 'C' + store.uuid().slice(0, 10), dueno: me.usuario, padreId: padreId, nombre: nombre, tipo: tipo,
        color: clip(f.color, 20), orden: all.length + 1, creado: store.now(), creadoPor: me.usuario, eliminado: 'FALSE'
      };
      store.insert('Carpetas', nf);
      log(me, 'crear', 'Carpeta', nf.id, me.usuario, 'nombre', '', nombre);
      return { folder: nf };
    },

    deleteFolder: function (req, me) {
      var all = liveFolders();
      var cur = findBy(all, req.id);
      if (!cur) throw err('La carpeta no existe.');
      if (cur.dueno !== me.usuario) throw err('Solo la dueña o el dueño del tablero puede eliminar sus carpetas.');
      if (all.some(function (f) { return f.padreId === cur.id; })) throw err('Primero elimina o mueve las subcarpetas.');
      if (liveTasks().some(function (t) { return t.carpetaId === cur.id; })) throw err('Primero mueve o elimina las tareas de esta carpeta.');
      var upd = copy(cur); upd.eliminado = 'TRUE';
      store.update('Carpetas', 'id', cur.id, upd);
      log(me, 'eliminar', 'Carpeta', cur.id, me.usuario, 'nombre', cur.nombre, '');
      return { ok: true };
    },

    saveTask: function (req, me) {
      var t = req.task || {};
      var titulo = clip(t.titulo, 200);
      if (!titulo) throw err('La tarea necesita un título.');
      var cur = t.id ? findBy(liveTasks(), t.id) : null;
      if (t.id && !cur) throw err('La tarea no existe o fue eliminada.');
      var dueno = cur ? cur.dueno : str(t.dueno) || me.usuario;
      if (!canSee(me, dueno)) throw err('No tienes acceso a este tablero.');
      var carpetaId = str(t.carpetaId);
      if (carpetaId) { var f = findBy(liveFolders(), carpetaId); if (!f || f.dueno !== dueno) throw err('Carpeta no válida para este tablero.'); }
      var estatus = MYA_ESTATUS.indexOf(t.estatus) >= 0 ? t.estatus : 'Pendiente';
      var fechaTentativa = str(t.fechaTentativa), fechaReal = str(t.fechaReal);
      if (!isDate(fechaTentativa) || !isDate(fechaReal)) throw err('Fecha no válida.');
      if (estatus === 'Completado' && !fechaReal) fechaReal = store.today();
      if (estatus !== 'Completado' && cur && cur.estatus === 'Completado' && fechaReal === str(cur.fechaReal)) fechaReal = '';
      var mciId = str(t.mciId);
      if (mciId) { var mm = findBy(liveRows('MCI'), mciId); if (!mm || mm.dueno !== dueno) throw err('La MCI elegida no pertenece a este tablero.'); }
      var enfoque = mciId ? 'MCI' : (MYA_ENFOQUE.indexOf(t.enfoque) >= 0 ? t.enfoque : (cur ? str(cur.enfoque) : 'Esporádica'));
      var fields = {
        carpetaId: carpetaId, titulo: titulo, descripcion: clip(t.descripcion, 3000),
        prioridad: MYA_PRIORIDAD.indexOf(t.prioridad) >= 0 ? t.prioridad : 'Media',
        estatus: estatus, fechaTentativa: fechaTentativa, fechaReal: fechaReal,
        mciId: mciId, enfoque: enfoque, tipo: clip(t.tipo, 60),
        avisos: t.avisos === undefined && cur ? str(cur.avisos) : cleanAvisos(t.avisos)
      };
      var actor = nameOf(me.usuario);
      if (cur) {
        var upd = copy(cur), changed = [];
        Object.keys(fields).forEach(function (k) {
          if (str(cur[k]) !== str(fields[k])) { log(me, 'editar', 'Tarea', cur.id, dueno, k, cur[k], fields[k]); changed.push(k); }
          upd[k] = fields[k];
        });
        if (!changed.length) return { id: cur.id };
        if (changed.indexOf('fechaTentativa') >= 0 || changed.indexOf('avisos') >= 0) upd.avisosEnviados = '';
        if (estatus === 'Completado' || estatus === 'Cancelado') liveRows('Tiempos').forEach(function (e) { if (e.tareaId === cur.id && !str(e.fin)) stopEntry(e); });
        upd.actualizado = store.now(); upd.actualizadoPor = me.usuario;
        store.update('Tareas', 'id', cur.id, upd);
        var q = '«' + titulo + '»';
        if (changed.indexOf('prioridad') >= 0) {
          var up = PRI_RANK[fields.prioridad] < PRI_RANK[cur.prioridad];
          notify(me, upd, 'prioridad', actor + (up ? ' SUBIÓ' : ' BAJÓ') + ' la prioridad de ' + q + ': ' + cur.prioridad + ' → ' + fields.prioridad, true);
        }
        if (changed.indexOf('fechaTentativa') >= 0) {
          var verbo = !cur.fechaTentativa ? 'fijó la fecha tentativa de ' : (!fechaTentativa ? 'quitó la fecha tentativa de ' : (fechaTentativa < cur.fechaTentativa ? 'ADELANTÓ la fecha tentativa de ' : 'POSPUSO la fecha tentativa de '));
          notify(me, upd, 'fecha', actor + ' ' + verbo + q + ': ' + (cur.fechaTentativa || 'sin fecha') + ' → ' + (fechaTentativa || 'sin fecha'), true);
        }
        if (changed.indexOf('estatus') >= 0) {
          notify(me, upd, estatus === 'Completado' ? 'completada' : 'estatus', actor + (estatus === 'Completado' ? ' completó ' + q : ' cambió el estatus de ' + q + ': ' + cur.estatus + ' → ' + estatus), false);
        }
        var otros = changed.filter(function (k) { return ['titulo', 'descripcion', 'carpetaId'].indexOf(k) >= 0; });
        if (otros.length) notify(me, upd, 'edicion', actor + ' editó ' + q + ' (' + otros.map(function (k) { return { titulo: 'título', descripcion: 'descripción', carpetaId: 'carpeta' }[k]; }).join(', ') + ')', false);
        return { id: cur.id };
      }
      var nt = {
        id: 'T' + store.uuid().slice(0, 10), dueno: dueno, fechaAsignacion: store.today(),
        asignadoPor: dueno === me.usuario ? '' : me.usuario, creadoPor: me.usuario, creado: store.now(),
        actualizado: store.now(), actualizadoPor: me.usuario, comentarios: '[]', eliminado: 'FALSE',
        avisosEnviados: '', recurrenciaId: '', checklist: cleanChecklist(t.checklist)
      };
      for (var k2 in fields) nt[k2] = fields[k2];
      store.insert('Tareas', nt);
      log(me, nt.asignadoPor ? 'asignar' : 'crear', 'Tarea', nt.id, dueno, 'titulo', '', titulo);
      if (nt.asignadoPor) notify(me, nt, 'asignacion', actor + ' te asignó «' + titulo + '» · prioridad ' + nt.prioridad + (fechaTentativa ? ' · fecha tentativa ' + fechaTentativa : ''), true);
      return { id: nt.id };
    },

    /* Importación masiva (desde Excel) — solo al propio tablero, sin notificaciones */
    importTasks: function (req, me) {
      var list = req.tasks || [];
      if (!list.length) throw err('No hay tareas para importar.');
      if (list.length > 300) throw err('Máximo 300 tareas por importación.');
      var carpetaId = str(req.carpetaId);
      if (carpetaId) { var f = findBy(liveFolders(), carpetaId); if (!f || f.dueno !== me.usuario) throw err('Carpeta no válida.'); }
      var n = 0;
      list.forEach(function (t) {
        if (!str(t.titulo)) return;
        var r = actions.saveTask({ task: { titulo: t.titulo, descripcion: t.descripcion, prioridad: t.prioridad, estatus: t.estatus,
          fechaTentativa: isDate(str(t.fechaTentativa)) ? str(t.fechaTentativa) : '', fechaReal: isDate(str(t.fechaReal)) ? str(t.fechaReal) : '',
          carpetaId: str(t.carpetaId) || carpetaId, dueno: me.usuario, enfoque: t.enfoque, tipo: t.tipo } }, me);
        if (r && r.id) n++;
      });
      log(me, 'importar', 'Tablero', me.usuario, me.usuario, 'tareas', '', n + ' tareas importadas');
      return { importadas: n };
    },

    deleteTask: function (req, me) {
      var cur = taskFor(me, req.id);
      if (cur.dueno !== me.usuario && cur.creadoPor !== me.usuario) throw err('Solo puede eliminarla la dueña del tablero o quien la creó.');
      var upd = copy(cur); upd.eliminado = 'TRUE'; upd.actualizado = store.now(); upd.actualizadoPor = me.usuario;
      store.update('Tareas', 'id', cur.id, upd);
      liveRows('Tiempos').forEach(function (e) { if (e.tareaId === cur.id && !str(e.fin)) stopEntry(e); });
      log(me, 'eliminar', 'Tarea', cur.id, cur.dueno, 'titulo', cur.titulo, '');
      return { ok: true };
    },

    addComment: function (req, me) {
      var cur = taskFor(me, req.id);
      var texto = clip(req.texto, 1500);
      if (!texto) throw err('El comentario está vacío.');
      var tipo = MYA_COMENTARIO_TIPOS.indexOf(req.tipo) >= 0 ? req.tipo : 'comentario';
      var adjuntoId = str(req.adjuntoId);
      var adj = null;
      if (adjuntoId) { adj = findBy(liveFiles(), adjuntoId); if (!adj || adj.tareaId !== cur.id) throw err('Archivo no válido.'); }
      var c = parseComments(cur);
      c.push({ id: 'K' + store.uuid().slice(0, 8), usuario: me.usuario, fecha: store.now(), texto: texto, tipo: tipo, adjuntoId: adjuntoId });
      var upd = copy(cur);
      upd.comentarios = JSON.stringify(c); upd.actualizado = store.now(); upd.actualizadoPor = me.usuario;
      store.update('Tareas', 'id', cur.id, upd);
      log(me, 'comentar', 'Tarea', cur.id, cur.dueno, 'comentario', '', texto);
      var etiqueta = tipo === 'cambios' ? ' pidió CAMBIOS' : (tipo === 'aprobado' ? ' APROBÓ' : ' comentó');
      notify(me, upd, 'comentario', nameOf(me.usuario) + etiqueta + (adj ? ' sobre el archivo "' + adj.nombre + '"' : '') + ' en «' + cur.titulo + '»: ' + texto, false);
      return { comentarios: c };
    },

    history: function (req, me) {
      var cur = findBy(store.rows('Tareas'), req.id);
      if (!cur || !canSee(me, cur.dueno)) throw err('No tienes acceso a esta tarea.');
      return { items: store.rows('Historial').filter(function (h) { return String(h.entidadId) === String(req.id); }).slice(-100).reverse() };
    },

    /* ---------- Archivos de avance ---------- */
    uploadFile: function (req, me) {
      var cur = taskFor(me, req.tareaId);
      var nombre = clip(req.nombre, 150).replace(/[\\\/:*?"<>|]/g, '_') || 'archivo';
      var b64 = str(req.b64);
      if (!b64) throw err('El archivo está vacío.');
      var bytes = Math.floor(b64.length * 3 / 4);
      var max = (store.maxFileMB || MYA_MAX_ARCHIVO_MB) * 1024 * 1024;
      if (bytes > max) throw err('El archivo supera el máximo de ' + (store.maxFileMB || MYA_MAX_ARCHIVO_MB) + ' MB.');
      var mime = clip(req.mime, 120) || 'application/octet-stream';
      var id = 'A' + store.uuid().slice(0, 12);
      var ref = store.fileSave(id + '_' + nombre, mime, b64);
      var a = { id: id, tareaId: cur.id, dueno: cur.dueno, nombre: nombre, mime: mime, tamano: bytes, ref: ref,
        subidoPor: me.usuario, fecha: store.now(), nota: clip(req.nota, 600), eliminado: 'FALSE' };
      store.insert('Adjuntos', a);
      log(me, 'adjuntar', 'Tarea', cur.id, cur.dueno, 'archivo', '', nombre);
      notify(me, cur, 'adjunto', nameOf(me.usuario) + ' subió un avance a «' + cur.titulo + '»: ' + nombre + (a.nota ? ' — ' + a.nota : ''), false);
      var o = copy(a); delete o.ref; return { file: o };
    },
    getFile: function (req, me) {
      var a = findBy(liveFiles(), req.id);
      if (!a) throw err('El archivo no existe.');
      taskFor(me, a.tareaId);
      return { nombre: a.nombre, mime: a.mime, b64: store.fileGet(a.ref) };
    },
    deleteFile: function (req, me) {
      var a = findBy(liveFiles(), req.id);
      if (!a) throw err('El archivo no existe.');
      var t = taskFor(me, a.tareaId);
      if (a.subidoPor !== me.usuario) throw err('Solo quien subió el archivo puede eliminarlo.');
      var upd = copy(a); upd.eliminado = 'TRUE';
      store.update('Adjuntos', 'id', a.id, upd);
      if (store.fileDelete) { try { store.fileDelete(a.ref); } catch (e) { } }
      log(me, 'eliminar archivo', 'Tarea', t.id, t.dueno, 'archivo', a.nombre, '');
      return { ok: true };
    },

    /* ---------- v3: MCI (Metas Crucialmente Importantes) — solo la dueña o el dueño las registra ---------- */
    saveMci: function (req, me) {
      var m = req.mci || {};
      var titulo = clip(m.titulo, 200);
      if (!titulo) throw err('La MCI necesita un nombre.');
      if (!isDate(str(m.fechaLimite))) throw err('Fecha no válida.');
      var f = { titulo: titulo, descripcion: clip(m.descripcion, 2000), indicador: clip(m.indicador, 300), fechaLimite: str(m.fechaLimite),
        estatus: MYA_MCI_ESTATUS.indexOf(m.estatus) >= 0 ? m.estatus : 'Activa', actualizado: store.now() };
      if (m.id) {
        var cur = findBy(liveRows('MCI'), m.id);
        if (!cur) throw err('La MCI no existe.');
        if (cur.dueno !== me.usuario) throw err('Solo la persona dueña de la MCI puede editarla.');
        var upd = copy(cur); for (var k in f) upd[k] = f[k];
        store.update('MCI', 'id', cur.id, upd);
        log(me, 'editar', 'MCI', cur.id, me.usuario, 'mci', cur.titulo, titulo);
        return { mci: upd };
      }
      var nm = { id: 'M' + store.uuid().slice(0, 10), dueno: me.usuario, creado: store.now(), eliminado: 'FALSE' };
      for (var k2 in f) nm[k2] = f[k2];
      store.insert('MCI', nm);
      log(me, 'crear', 'MCI', nm.id, me.usuario, 'mci', '', titulo);
      return { mci: nm };
    },
    deleteMci: function (req, me) {
      var cur = findBy(liveRows('MCI'), req.id);
      if (!cur || cur.dueno !== me.usuario) throw err('Solo la persona dueña de la MCI puede eliminarla.');
      if (liveTasks().some(function (t) { return t.mciId === cur.id; })) throw err('Hay tareas vinculadas a esta MCI. Cámbiales la MCI o márcala como Cancelada.');
      var upd = copy(cur); upd.eliminado = 'TRUE'; store.update('MCI', 'id', cur.id, upd);
      log(me, 'eliminar', 'MCI', cur.id, me.usuario, 'mci', cur.titulo, '');
      return { ok: true };
    },

    /* ---------- v3: registro de tiempo (cronómetro) — cada quien registra el suyo ---------- */
    timerStart: function (req, me) {
      var t = taskFor(me, req.tareaId);
      if (t.dueno !== me.usuario) throw err('Solo puedes registrar tiempo en tus propias tareas.');
      if (t.estatus === 'Completado' || t.estatus === 'Cancelado') throw err('La tarea ya está cerrada. Reábrela para registrar tiempo.');
      var run = runningFor(me.usuario), stopped = null;
      if (run) { if (run.tareaId === t.id) return { entrada: run }; stopped = stopEntry(run); }
      var e = { id: 'R' + store.uuid().slice(0, 12), tareaId: t.id, dueno: t.dueno, usuario: me.usuario, inicio: store.now(),
        inicioMs: String(store.nowMs()), fin: '', segundos: '', fuente: 'cronometro', nota: '', eliminado: 'FALSE' };
      store.insert('Tiempos', e);
      if (t.estatus === 'Pendiente') {
        var u = copy(t); u.estatus = 'En progreso'; u.actualizado = store.now(); u.actualizadoPor = me.usuario;
        store.update('Tareas', 'id', t.id, u); log(me, 'editar', 'Tarea', t.id, t.dueno, 'estatus', 'Pendiente', 'En progreso');
      }
      return { entrada: e, detenida: stopped };
    },
    timerStop: function (req, me) {
      var run = runningFor(me.usuario);
      if (!run) return { detenida: null };
      return { detenida: stopEntry(run) };
    },
    saveTime: function (req, me) {
      var minutos = Math.round(Number(req.minutos));
      if (!(minutos > 0) || minutos > 16 * 60) throw err('Escribe una duración entre 1 minuto y 16 horas.');
      var fecha = str(req.fecha) || store.today();
      if (!isDate(fecha)) throw err('Fecha no válida.');
      if (req.id) {
        var cur = findBy(liveRows('Tiempos'), req.id);
        if (!cur || cur.usuario !== me.usuario) throw err('Solo puedes editar tus propios registros de tiempo.');
        var upd = copy(cur);
        if (!str(cur.fin)) { upd.fin = store.now(); }
        upd.segundos = String(minutos * 60); upd.nota = clip(req.nota, 200);
        if (fecha !== str(cur.inicio).slice(0, 10)) { upd.inicio = fecha + ' 12:00:00'; upd.inicioMs = String(Date.parse(fecha + 'T12:00:00-05:00')); }
        store.update('Tiempos', 'id', cur.id, upd);
        return { entrada: upd };
      }
      var t = taskFor(me, req.tareaId);
      if (t.dueno !== me.usuario) throw err('Solo puedes registrar tiempo en tus propias tareas.');
      var e = { id: 'R' + store.uuid().slice(0, 12), tareaId: t.id, dueno: t.dueno, usuario: me.usuario, inicio: fecha + ' 12:00:00',
        inicioMs: String(Date.parse(fecha + 'T12:00:00-05:00')), fin: fecha + ' 12:00:00', segundos: String(minutos * 60), fuente: 'manual',
        nota: clip(req.nota, 200), eliminado: 'FALSE' };
      store.insert('Tiempos', e);
      return { entrada: e };
    },
    deleteTime: function (req, me) {
      var cur = findBy(liveRows('Tiempos'), req.id);
      if (!cur || cur.usuario !== me.usuario) throw err('Solo puedes eliminar tus propios registros de tiempo.');
      var upd = copy(cur); upd.eliminado = 'TRUE'; if (!str(cur.fin)) upd.fin = store.now();
      store.update('Tiempos', 'id', cur.id, upd);
      return { ok: true };
    },

    /* ---------- v3: lista de seguimiento dentro de una tarea (ej. qué deudor pagó) ---------- */
    saveChecklist: function (req, me) {
      var t = taskFor(me, req.id);
      var c = cleanChecklist(req.checklist);
      var prev = parseJSON(t.checklist, null), next = parseJSON(c, null);
      if (next) next.pasos.forEach(function (p, i) {
        var old = prev && prev.pasos && prev.pasos[i];
        if (p.ok && !(old && old.ok && old.t === p.t)) { p.por = me.usuario; p.fecha = store.now().slice(0, 16); }
        else if (p.ok && old) { p.por = old.por; p.fecha = old.fecha; }
        else { p.por = ''; p.fecha = ''; }
      });
      var u = copy(t); u.checklist = next ? JSON.stringify(next) : ''; u.actualizado = store.now(); u.actualizadoPor = me.usuario;
      store.update('Tareas', 'id', t.id, u);
      log(me, 'editar', 'Tarea', t.id, t.dueno, 'seguimiento', '', 'lista de seguimiento actualizada');
      return { checklist: next };
    },

    /* ---------- v3: seguimientos (proyectos / pendientes conectados a una persona) ---------- */
    saveSeguimiento: function (req, me) {
      var s = req.seguimiento || {};
      var titulo = clip(s.titulo, 200);
      if (!titulo) throw err('El seguimiento necesita un título.');
      var responsable = low(s.responsable), vis = visibleOwners(me);
      if (responsable && (responsable === me.usuario || !vis[responsable])) throw err('Solo puedes conectar personas de tu equipo. Para otras personas escribe su nombre.');
      var responsableNombre = responsable ? '' : clip(s.responsableNombre, 80);
      if (!isDate(str(s.proximaFecha))) throw err('Fecha no válida.');
      var tareaId = str(s.tareaId);
      if (tareaId) { var lt = findBy(liveTasks(), tareaId); if (!lt || !canSee(me, lt.dueno)) throw err('Tarea vinculada no válida.'); }
      var f = { titulo: titulo, responsable: responsable, responsableNombre: responsableNombre, queSeguir: clip(s.queSeguir, 2000),
        proximaFecha: str(s.proximaFecha), estatus: MYA_SEG_ESTATUS.indexOf(s.estatus) >= 0 ? s.estatus : 'Abierto',
        compartido: responsable && s.compartido ? 'TRUE' : 'FALSE', tareaId: tareaId, actualizado: store.now() };
      var cur = s.id ? findBy(liveRows('Seguimientos'), s.id) : null;
      if (s.id && (!cur || cur.dueno !== me.usuario)) throw err('Solo quien creó el seguimiento puede editarlo.');
      var row;
      if (cur) { row = copy(cur); for (var k in f) row[k] = f[k]; store.update('Seguimientos', 'id', cur.id, row); }
      else {
        row = { id: 'S' + store.uuid().slice(0, 10), dueno: me.usuario, bitacora: '[]', avisado: '', creado: store.now(), eliminado: 'FALSE' };
        for (var k2 in f) row[k2] = f[k2];
        store.insert('Seguimientos', row);
      }
      log(me, cur ? 'editar' : 'crear', 'Seguimiento', row.id, me.usuario, 'seguimiento', cur ? cur.titulo : '', titulo);
      if (row.compartido === 'TRUE' && (!cur || cur.compartido !== 'TRUE' || cur.responsable !== row.responsable))
        store.insert('Notificaciones', { id: 'N' + store.uuid().slice(0, 12), para: row.responsable, de: me.usuario, tareaId: row.id, dueno: me.usuario,
          tipo: 'seguimiento', mensaje: clip(nameOf(me.usuario) + ' te conectó al seguimiento «' + titulo + '»' + (row.queSeguir ? ': ' + row.queSeguir : ''), 600), fecha: store.now(), leida: 'FALSE' });
      return { id: row.id };
    },
    addSeguimientoNota: function (req, me) {
      var cur = findBy(liveRows('Seguimientos'), req.id);
      if (!cur) throw err('El seguimiento no existe.');
      var esDueno = cur.dueno === me.usuario, esResp = isTrue(cur.compartido) && cur.responsable === me.usuario;
      if (!esDueno && !esResp) throw err('No tienes acceso a este seguimiento.');
      var texto = clip(req.texto, 1500);
      if (!texto) throw err('Escribe la nota del seguimiento.');
      var b = parseJSON(cur.bitacora, []);
      b.push({ id: 'B' + store.uuid().slice(0, 8), usuario: me.usuario, fecha: store.now(), texto: texto });
      var u = copy(cur); u.bitacora = JSON.stringify(b.slice(-200)); u.actualizado = store.now();
      if (esDueno) {
        if (req.proximaFecha !== undefined) { if (!isDate(str(req.proximaFecha))) throw err('Fecha no válida.'); u.proximaFecha = str(req.proximaFecha); }
        if (MYA_SEG_ESTATUS.indexOf(req.estatus) >= 0) u.estatus = req.estatus;
      }
      store.update('Seguimientos', 'id', cur.id, u);
      var para = esDueno ? (isTrue(cur.compartido) ? cur.responsable : '') : cur.dueno;
      if (para) store.insert('Notificaciones', { id: 'N' + store.uuid().slice(0, 12), para: para, de: me.usuario, tareaId: cur.id, dueno: cur.dueno,
        tipo: 'seguimiento', mensaje: clip(nameOf(me.usuario) + ' actualizó el seguimiento «' + cur.titulo + '»: ' + texto, 600), fecha: store.now(), leida: 'FALSE' });
      return { bitacora: b, proximaFecha: u.proximaFecha, estatus: u.estatus };
    },
    deleteSeguimiento: function (req, me) {
      var cur = findBy(liveRows('Seguimientos'), req.id);
      if (!cur || cur.dueno !== me.usuario) throw err('Solo quien creó el seguimiento puede eliminarlo.');
      var u = copy(cur); u.eliminado = 'TRUE'; store.update('Seguimientos', 'id', cur.id, u);
      log(me, 'eliminar', 'Seguimiento', cur.id, me.usuario, 'seguimiento', cur.titulo, '');
      return { ok: true };
    },

    /* ---------- v3: obligaciones recurrentes (calendario) ---------- */
    saveRecurrente: function (req, me) {
      var r = req.recurrente || {};
      var titulo = clip(r.titulo, 150);
      if (!titulo) throw err('La obligación necesita un nombre.');
      var frecuencia = MYA_FRECUENCIAS.indexOf(r.frecuencia) >= 0 ? r.frecuencia : 'mensual';
      var intervalo = Math.round(Number(r.intervalo) || 1);
      if (intervalo < 1 || intervalo > 24) throw err('El intervalo debe estar entre 1 y 24.');
      var inicio = str(r.inicio) || store.today(), fin = str(r.fin);
      if (!isDate(inicio) || !isDate(fin)) throw err('Fecha no válida.');
      var dias;
      if (frecuencia === 'diaria') dias = str(r.dia) === 'habiles' ? ['habiles'] : [''];
      else if (frecuencia === 'anual') dias = [Number(inicio.slice(8, 10))];
      else {
        dias = str(r.dia).split(/[,;\s]+/).map(function (x) { return parseInt(x, 10); }).filter(function (n, i, a) {
          return !isNaN(n) && a.indexOf(n) === i && (frecuencia === 'semanal' ? n >= 1 && n <= 7 : n >= 1 && n <= 31); }).sort(function (a, b) { return a - b; });
        if (!dias.length) throw err(frecuencia === 'semanal' ? 'Elige al menos un día de la semana.' : 'Escribe el día del mes (ej. 5, o 15,30; 31 = último día del mes).');
      }
      if (fin && fin < inicio) throw err('La fecha final debe ser posterior al inicio.');
      var carpetaId = str(r.carpetaId);
      if (carpetaId) { var fo = findBy(liveFolders(), carpetaId); if (!fo || fo.dueno !== me.usuario) throw err('Carpeta no válida.'); }
      var mciId = str(r.mciId);
      if (mciId) { var mm = findBy(liveRows('MCI'), mciId); if (!mm || mm.dueno !== me.usuario) throw err('MCI no válida.'); }
      var pl = r.plantilla || {};
      var plantilla = {
        pasos: (pl.pasos || []).map(function (x) { return clip(x, 200); }).filter(String).slice(0, 30),
        items: (pl.items || []).map(function (x) { return clip(x, 120); }).filter(String).slice(0, 60),
        columnas: (pl.columnas || []).map(function (x) { return clip(x, 40); }).filter(String).slice(0, 6)
      };
      var f = { titulo: titulo, descripcion: clip(r.descripcion, 2000), carpetaId: carpetaId,
        prioridad: MYA_PRIORIDAD.indexOf(r.prioridad) >= 0 ? r.prioridad : 'Media', tipo: clip(r.tipo, 60), mciId: mciId,
        enfoque: mciId ? 'MCI' : (MYA_ENFOQUE.indexOf(r.enfoque) >= 0 ? r.enfoque : 'Rutina'), frecuencia: frecuencia, dia: dias.join(','), intervalo: String(intervalo),
        ajuste: MYA_AJUSTES.indexOf(r.ajuste) >= 0 ? r.ajuste : 'ninguno', inicio: inicio, fin: fin, avisos: cleanAvisos(r.avisos),
        plantilla: JSON.stringify(plantilla), activo: r.activo === false ? 'FALSE' : 'TRUE' };
      var cur = r.id ? findBy(liveRows('Recurrentes'), r.id) : null;
      if (r.id && (!cur || cur.dueno !== me.usuario)) throw err('Solo la persona dueña puede editar esta obligación.');
      var row;
      if (cur) {
        row = copy(cur); for (var k in f) row[k] = f[k];
        // si cambió la regla, las ocurrencias futuras aún no creadas se recalculan desde hoy
        if (cur.frecuencia !== f.frecuencia || cur.dia !== f.dia || cur.ajuste !== f.ajuste || cur.inicio !== f.inicio || String(intervalOf(cur)) !== f.intervalo) {
          var hoy = store.today();
          liveTasks().forEach(function (t) {
            if (t.recurrenciaId === cur.id && t.fechaTentativa > hoy && t.estatus === 'Pendiente' && !liveRows('Tiempos').some(function (e) { return e.tareaId === t.id; })) {
              var ut = copy(t); ut.eliminado = 'TRUE'; store.update('Tareas', 'id', t.id, ut);
            }
          });
          row.ultimaGenerada = cur.ultimaGenerada && cur.ultimaGenerada < hoy ? cur.ultimaGenerada : hoy;
          if (row.ultimaGenerada < f.inicio) row.ultimaGenerada = '';
        }
        store.update('Recurrentes', 'id', cur.id, row);
      } else {
        row = { id: 'P' + store.uuid().slice(0, 10), dueno: me.usuario, ultimaGenerada: '', creado: store.now(), eliminado: 'FALSE' };
        for (var k2 in f) row[k2] = f[k2];
        store.insert('Recurrentes', row);
      }
      log(me, cur ? 'editar' : 'crear', 'Recurrente', row.id, me.usuario, 'obligación', cur ? cur.titulo : '', titulo + ' · ' + frecuencia + ' cada ' + f.intervalo + ' · ' + f.dia);
      var n = generateRecurring(me.usuario);
      return { id: row.id, creadas: n };
    },
    /* Vista previa: próximas fechas de una regla, sin guardar nada */
    previewRecurrente: function (req, me) {
      var r = req.recurrente || {};
      var x = { frecuencia: MYA_FRECUENCIAS.indexOf(r.frecuencia) >= 0 ? r.frecuencia : 'mensual', intervalo: r.intervalo, ajuste: r.ajuste,
        inicio: isDate(str(r.inicio)) && str(r.inicio) ? str(r.inicio) : store.today(), dia: str(r.dia) };
      if (x.frecuencia === 'anual') x.dia = String(Number(x.inicio.slice(8, 10)));
      var from = x.inicio > store.today() ? x.inicio : store.today(), out = [];
      for (var d = from, g = 0; out.length < 6 && g < 800; d = addD(d, 1), g++) {
        if (r.fin && d > str(r.fin)) break;
        if (isBaseDate(x, d)) out.push(adjustDate(x, d));
      }
      return { fechas: out };
    },
    deleteRecurrente: function (req, me) {
      var cur = findBy(liveRows('Recurrentes'), req.id);
      if (!cur || cur.dueno !== me.usuario) throw err('Solo la persona dueña puede eliminar esta obligación.');
      var u = copy(cur); u.eliminado = 'TRUE'; store.update('Recurrentes', 'id', cur.id, u);
      var hoy = store.today(), n = 0;
      if (req.borrarFuturas) liveTasks().forEach(function (t) {
        if (t.recurrenciaId === cur.id && t.fechaTentativa > hoy && t.estatus === 'Pendiente') { var ut = copy(t); ut.eliminado = 'TRUE'; store.update('Tareas', 'id', t.id, ut); n++; }
      });
      log(me, 'eliminar', 'Recurrente', cur.id, me.usuario, 'obligación', cur.titulo, '');
      return { ok: true, eliminadas: n };
    },

    /* ---------- Notificaciones ---------- */
    markRead: function (req, me) {
      var ids = req.all ? null : (req.ids || []);
      store.rows('Notificaciones').forEach(function (n) {
        if (n.para !== me.usuario || isTrue(n.leida)) return;
        if (ids && ids.indexOf(n.id) < 0) return;
        var u = copy(n); u.leida = 'TRUE'; store.update('Notificaciones', 'id', n.id, u);
      });
      return { ok: true };
    },

    changePassword: function (req, me) {
      if (store.hash(me.salt, str(req.actual)) !== me.hash) throw err('La contraseña actual no es correcta.');
      var n = str(req.nueva);
      if (n.length < 8) throw err('La nueva contraseña debe tener al menos 8 caracteres.');
      if (n === str(req.actual)) throw err('La nueva contraseña debe ser distinta a la actual.');
      var upd = copy(me); upd.salt = store.uuid(); upd.hash = store.hash(upd.salt, n); upd.debeCambiar = 'FALSE';
      store.update('Usuarios', 'usuario', me.usuario, upd);
      if (store.sessionDelUser) store.sessionDelUser(me.usuario, req.token);
      log(me, 'cambiar contraseña', 'Usuario', me.usuario, me.usuario, '', '', '');
      return { ok: true };
    },

    /* ---------- Administración (solo administradores) ----------
       Gestiona personas, roles y vínculos jefe–colaborador. NUNCA devuelve tareas. */
    users: function (req, me) {
      if (!isAdmin(me)) throw err('Solo administración.');
      var all = users();
      return {
        users: all.map(function (u) {
          var p = publicUser(u);
          p.puedeVer = u.puedeVer; p.email = u.email; p.activo = isTrue(u.activo); p.tieneClave = !!u.hash; p.creado = u.creado;
          p.veA = isTrue(u.activo) ? Object.keys(visibleOwners(u)).filter(function (x) { return x !== u.usuario; }) : [];
          return p;
        })
      };
    },
    saveUser: function (req, me) {
      if (!isAdmin(me)) throw err('Solo administración.');
      var u = req.user || {};
      var usuario = low(u.usuario);
      if (!/^[a-z0-9._-]{3,30}$/.test(usuario)) throw err('Usuario no válido (3-30 letras minúsculas, números, punto o guion).');
      var cur = userBy(usuario);
      var row = cur ? copy(cur) : { usuario: usuario, creado: store.now(), salt: '', hash: '' };
      var nuevo = {
        nombre: clip(u.nombre, 80), cargo: clip(u.cargo, 80), area: clip(u.area, 60), email: clip(u.email, 120),
        jefe: low(u.jefe), puedeVer: clip(u.puedeVer, 500),
        rol: MYA_ROLES.indexOf(u.rol) >= 0 ? u.rol : 'colaborador',
        esAdmin: u.esAdmin ? 'TRUE' : 'FALSE', activo: u.activo === false ? 'FALSE' : 'TRUE'
      };
      if (!nuevo.nombre) throw err('Escribe el nombre completo.');
      if (nuevo.jefe && !userBy(nuevo.jefe)) throw err('El jefe seleccionado no existe.');
      if (nuevo.jefe === usuario) throw err('Una persona no puede ser su propio jefe.');
      // evitar ciclos: A jefe de B y B jefe de A
      var x = nuevo.jefe, guard = 0;
      while (x && guard++ < 50) { if (x === usuario) throw err('Esa relación crea un círculo en la jerarquía.'); var px = userBy(x); x = px ? low(px.jefe) : ''; }
      if (nuevo.rol === 'colaborador' && str(nuevo.puedeVer)) throw err('Los colaboradores solo ven su propio tablero: deja "Accesos adicionales" vacío o cambia el rol a Jefe / CEO.');
      /* Salvaguardas: quien administra no puede darse acceso a sí misma. */
      if (usuario === me.usuario) {
        // Puede indicar a quién reporta (eso da acceso a su jefe, no a ella), pero no darse más visibilidad.
        if (str(cur && cur.puedeVer) !== nuevo.puedeVer || roleOf(cur) !== nuevo.rol || isAdmin(cur) !== (nuevo.esAdmin === 'TRUE') || nuevo.activo !== 'TRUE')
          throw err('Por seguridad no puedes cambiar tu propio rol, accesos ni permisos de administración. Pídeselo a otra persona administradora.');
      }
      if (nuevo.jefe === me.usuario) throw err('Como administradora no puedes asignarte como jefa de nadie (te daría acceso a sus tareas). Otra persona administradora debe hacerlo.');
      for (var k in nuevo) row[k] = nuevo[k];
      if (str(u.password)) {
        if (str(u.password).length < 8) throw err('La contraseña debe tener al menos 8 caracteres.');
        row.salt = store.uuid(); row.hash = store.hash(row.salt, str(u.password));
        row.debeCambiar = usuario === me.usuario ? 'FALSE' : 'TRUE'; // contraseña temporal: debe cambiarla al entrar
      }
      if (!cur && !row.hash) throw err('Asigna una contraseña inicial a la nueva persona.');
      if (cur) store.update('Usuarios', 'usuario', usuario, row); else store.insert('Usuarios', row);
      if (cur && store.sessionDelUser && usuario !== me.usuario && (str(u.password) || row.activo !== 'TRUE')) store.sessionDelUser(usuario);
      log(me, cur ? 'editar' : 'crear', 'Usuario', usuario, usuario, '', '',
        'rol=' + row.rol + ' jefe=' + (row.jefe || '-') + ' accesos=' + (row.puedeVer || '-') + ' admin=' + row.esAdmin + ' activo=' + row.activo + (str(u.password) ? ' (contraseña asignada)' : ''));
      return { ok: true };
    }
  };

  function handle(req) {
    try {
      req = req || {};
      var a = actions[req.action];
      if (!a) throw err('Acción desconocida.');
      if (['login', 'logout', 'setupStatus', 'setupAdmin', 'createPassword'].indexOf(req.action) >= 0) return { ok: true, data: a(req) };
      var me = sessionUser(req.token);
      if (isTrue(me.debeCambiar) && req.action !== 'changePassword') throw err('DEBE_CAMBIAR');
      return { ok: true, data: a(req, me) };
    } catch (e) {
      return { ok: false, error: e.userFacing ? e.message : 'Error interno: ' + (e && e.message) };
    }
  }

  /* Tarea diaria (servidor): crea ocurrencias de obligaciones recurrentes y envía avisos por página y correo */
  function dailyJob() { var n = generateRecurring(''); var r = runAlerts({ mail: true }); r.ocurrencias = n; return r; }

  return { handle: handle, visibleOwners: visibleOwners, dailyJob: dailyJob };
}

/* ======================= 2) ALMACENAMIENTO EN GOOGLE SHEETS ======================= */
var HOJA_SESIONES = ['huella', 'usuario', 'creado', 'ultimo', 'vence'];

function zonaT_() { return Session.getScriptTimeZone() || 'America/Panama'; }
function fmtT_(d, f) { return Utilities.formatDate(d, zonaT_(), f); }
function shaT_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function crearStore_() {
  var libro = SpreadsheetApp.getActiveSpreadsheet(), cache = {}, props = PropertiesService.getScriptProperties(), cc = CacheService.getScriptCache();

  function encabezado_(nombre, cols) {
    var sh = libro.getSheetByName(nombre);
    if (!sh) {
      sh = libro.insertSheet(nombre);
      sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
      sh.setFrozenRows(1);
      sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@');   // todo como texto
      return {sh: sh, H: cols.slice()};
    }
    var n = Math.max(sh.getLastColumn ? sh.getLastColumn() : cols.length, 1);
    var H = sh.getRange(1, 1, 1, n).getValues()[0].map(String).filter(function (x) { return x !== ''; });
    var faltan = cols.filter(function (c) { return H.indexOf(c) < 0; });          // columnas nuevas de versiones futuras
    if (faltan.length) { sh.getRange(1, H.length + 1, 1, faltan.length).setValues([faltan]).setFontWeight('bold'); H = H.concat(faltan); }
    return {sh: sh, H: H};
  }
  function tabla_(t) {
    if (cache[t]) return cache[t];
    var cols = t === 'Sesiones' ? HOJA_SESIONES : MYA_SCHEMA[t];
    if (!cols) throw new Error('Tabla desconocida: ' + t);
    var e = encabezado_(t, cols), last = e.sh.getLastRow(), objs = [], filas = [];
    if (last > 1) {
      e.sh.getRange(2, 1, last - 1, e.H.length).getValues().forEach(function (r, i) {
        if (r.every(function (v) { return v === '' || v === null; })) return;
        var o = {}; e.H.forEach(function (k, j) { var v = r[j]; o[k] = v instanceof Date ? fmtT_(v, 'yyyy-MM-dd HH:mm:ss') : (v === null || v === undefined ? '' : String(v)); });
        objs.push(o); filas.push(i + 2);
      });
    }
    return (cache[t] = {sh: e.sh, H: e.H, objs: objs, filas: filas});
  }
  function aFila_(T, o) { return T.H.map(function (k) { var v = o[k]; return v === null || v === undefined ? '' : String(v); }); }
  function escribir_(T, fila, o) { var rg = T.sh.getRange(fila, 1, 1, T.H.length); rg.setNumberFormat('@'); rg.setValues([aFila_(T, o)]); }
  function copia_(o) { var c = {}; for (var k in o) c[k] = o[k]; return c; }

  var S = {
    rows: function (t) { return tabla_(t).objs.map(copia_); },
    insert: function (t, o) {
      var T = tabla_(t), fila = T.sh.getLastRow() + 1, limpio = {};
      T.H.forEach(function (k) { limpio[k] = o[k] === null || o[k] === undefined ? '' : String(o[k]); });
      escribir_(T, fila, limpio); T.objs.push(limpio); T.filas.push(fila);
    },
    update: function (t, kf, kv, o) {
      var T = tabla_(t), clave = String(kv).toLowerCase();
      for (var i = 0; i < T.objs.length; i++) {
        if (String(T.objs[i][kf]).toLowerCase() !== clave) continue;
        var limpio = {}; T.H.forEach(function (k) { limpio[k] = o[k] === null || o[k] === undefined ? '' : String(o[k]); });
        escribir_(T, T.filas[i], limpio); T.objs[i] = limpio; return;
      }
      throw new Error('no encontrado');
    },

    /* ---- sesiones (pestaña Sesiones: se guarda la huella del token, no el token) ---- */
    sessionGet: function (token) {
      var h = shaT_(String(token)), T = tabla_('Sesiones'), ahora = Date.now();
      for (var i = 0; i < T.objs.length; i++) if (T.objs[i].huella === h) return Number(T.objs[i].vence) > ahora ? T.objs[i].usuario : null;
      return null;
    },
    sessionPut: function (token, usuario) {
      var h = shaT_(String(token)), T = tabla_('Sesiones'), ahora = Date.now(), vence = String(ahora + AJUSTES.SESION_DIAS * 864e5);
      for (var i = 0; i < T.objs.length; i++) if (T.objs[i].huella === h) {
        if (ahora - Number(T.objs[i].ultimo) < 30 * 60 * 1000) return;           // se renueva como mucho cada 30 min
        T.objs[i].ultimo = String(ahora); T.objs[i].vence = vence; escribir_(T, T.filas[i], T.objs[i]); return;
      }
      S.insert('Sesiones', {huella: h, usuario: usuario, creado: fmtT_(new Date(), 'yyyy-MM-dd HH:mm:ss'), ultimo: String(ahora), vence: vence});
      limpiarSesiones_();
    },
    sessionDel: function (token) { borrarSesiones_(function (s) { return s.huella === shaT_(String(token)); }); },
    sessionDelUser: function (usuario, salvoToken) {
      var salvo = salvoToken ? shaT_(String(salvoToken)) : null;
      borrarSesiones_(function (s) { return String(s.usuario).toLowerCase() === String(usuario).toLowerCase() && s.huella !== salvo; });
    },

    /* ---- intentos fallidos: 15 minutos ---- */
    failCount: function (u) { return Number(cc.get('fallos_' + u) || 0); },
    failInc: function (u) { cc.put('fallos_' + u, String(S.failCount(u) + 1), 900); },
    failReset: function (u) { cc.remove('fallos_' + u); },

    hash: function (salt, clave) { var h = shaT_(salt + '|' + clave); for (var i = 1; i < AJUSTES.ITERACIONES; i++) h = shaT_(salt + '|' + h); return h; },
    maxFileMB: AJUSTES.MAX_ARCHIVO_MB,

    /* ---- adjuntos en Google Drive (carpeta privada del dueño del script) ---- */
    fileSave: function (nombre, mime, b64) {
      var blob = Utilities.newBlob(Utilities.base64Decode(b64), mime || 'application/octet-stream', nombre);
      return carpeta_().createFile(blob).getId();
    },
    fileGet: function (ref) { return Utilities.base64Encode(DriveApp.getFileById(ref).getBlob().getBytes()); },
    fileDelete: function (ref) { try { DriveApp.getFileById(ref).setTrashed(true); } catch (e) {} },

    /* ---- correo diario con avisos (solo si está activado) ---- */
    sendAlertMail: AJUSTES.CORREO_RESUMEN_DIARIO ? function (email, nombre, avisos) {
      var cuerpo = 'Hola ' + (nombre || '') + ',\n\nEstos son tus avisos de hoy en el Seguimiento de tareas:\n\n' +
        avisos.map(function (a) { return '• ' + a; }).join('\n') + '\n\nRapiPréstamos · Seguimiento de tareas';
      MailApp.sendEmail(email, 'Tus avisos de tareas · ' + fmtT_(new Date(), 'dd/MM/yyyy'), cuerpo);
    } : undefined,

    nowMs: function () { return Date.now(); },
    uuid: function () { return Utilities.getUuid().replace(/-/g, ''); },
    now: function () { return fmtT_(new Date(), 'yyyy-MM-dd HH:mm:ss'); },
    today: function () { return fmtT_(new Date(), 'yyyy-MM-dd'); }
  };

  function borrarSesiones_(fn) {
    var T = tabla_('Sesiones'), quitar = [];
    T.objs.forEach(function (s, i) { if (fn(s)) quitar.push(i); });
    quitar.reverse().forEach(function (i) { T.sh.deleteRow(T.filas[i]); T.objs.splice(i, 1); T.filas.splice(i, 1); for (var j = i; j < T.filas.length; j++) T.filas[j]--; });
  }
  function limpiarSesiones_() { var ahora = Date.now(); if (tabla_('Sesiones').objs.length > 50) borrarSesiones_(function (s) { return Number(s.vence) < ahora; }); }
  function carpeta_() {
    var id = props.getProperty('CARPETA_ADJUNTOS');
    if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
    var f = DriveApp.getRootFolder().createFolder(AJUSTES.CARPETA_ADJUNTOS);
    props.setProperty('CARPETA_ADJUNTOS', f.getId());
    return f;
  }
  return S;
}

/* ======================= Entrada web ======================= */
function doGet() { return ContentService.createTextOutput(JSON.stringify({ok: true, servicio: 'Seguimiento de tareas', version: MYA_CORE_VERSION})).setMimeType(ContentService.MimeType.JSON); }

function doPost(e) {
  var req, res;
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { req = null; }
  if (!req) res = {ok: false, error: 'Solicitud inválida.'};
  else {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(25000)) res = {ok: false, error: 'El servidor está ocupado. Intenta de nuevo en unos segundos.'};
    else {
      try { res = createMyaCore(crearStore_()).handle(req); }
      catch (err) { console.error(err && err.stack || err); res = {ok: false, error: 'Error interno: ' + (err && err.message)}; }
      finally { lock.releaseLock(); }
    }
  }
  return ContentService.createTextOutput(JSON.stringify(res)).setMimeType(ContentService.MimeType.JSON);
}

/* ======================= Tarea diaria (7 a. m.): recurrentes + avisos ======================= */
function tareaDiaria() {
  var lock = LockService.getScriptLock(); lock.waitLock(60000);
  try { var r = createMyaCore(crearStore_()).dailyJob(); console.log('Tarea diaria: ' + JSON.stringify(r)); return r; }
  finally { lock.releaseLock(); }
}

/* ======================= Instalación (una vez) ======================= */
function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('Seguimiento de tareas')
      .addItem('Instalar (pestañas y tarea diaria)', 'instalar')
      .addItem('Permitir que un usuario cree una contraseña nueva…', 'permitirNuevaClave')
      .addToUi();
  } catch (e) {}
}
function avisoT_(titulo, msg) { try { SpreadsheetApp.getUi().alert(titulo, msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {} console.log(titulo + ': ' + msg); }
function instalar() {
  var S = crearStore_();
  Object.keys(MYA_SCHEMA).forEach(function (t) { S.rows(t); });
  S.rows('Sesiones');
  var hay = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'tareaDiaria'; });
  if (!hay) ScriptApp.newTrigger('tareaDiaria').timeBased().everyDays(1).atHour(7).create();
  avisoT_('Seguimiento de tareas', 'Listo: pestañas creadas y tarea diaria de las 7 a. m. programada.\n\n' +
    'Ahora publica el script (Implementar → Nueva implementación → Aplicación web) y pega la URL en index.html. ' +
    'La primera vez que abras la página te pedirá crear la cuenta de administración.');
}
/* Rescate: si alguien (o la administradora) olvidó su contraseña y no hay otra persona administradora,
   esto la deja sin contraseña; al entrar con su usuario, la página le pide crear una nueva. */
function permitirNuevaClave() {
  var ui = SpreadsheetApp.getUi(), r = ui.prompt('Usuario que creará una contraseña nueva', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var usuario = String(r.getResponseText()).trim().toLowerCase(), S = crearStore_();
  var u = S.rows('Usuarios').filter(function (x) { return String(x.usuario).toLowerCase() === usuario; })[0];
  if (!u) { avisoT_('No encontrado', 'No existe el usuario ' + usuario); return; }
  u.hash = ''; u.salt = ''; u.debeCambiar = 'FALSE'; S.update('Usuarios', 'usuario', usuario, u); S.sessionDelUser(usuario);
  avisoT_('Listo', usuario + ' podrá crear una contraseña nueva al entrar a la página. Avísale que lo haga cuanto antes.');
}
