# Seguimiento de tareas · RapiPréstamos

Tareas por persona y por proyecto, jefes y colaboradores, metas (MCI), registro de tiempo, obligaciones recurrentes,
seguimientos, adjuntos y avisos.

- **Página:** `index.html` (GitHub Pages). No trae datos: los pide al servidor después de entrar.
- **Servidor y base de datos:** Google Apps Script (`apps-script/Code.gs`) sobre una hoja de Google. Los adjuntos van a una carpeta de tu Google Drive.
- `Code.gs` lleva **la misma lógica central** que `index.html` (quién ve qué y qué puede hacer). Si se cambia en uno, se copia igual en el otro.

## Puesta en marcha (una sola vez)

1. **Hoja de Google.** Crea una hoja nueva (por ejemplo "Seguimiento de tareas — base"). No la compartas.
2. **Apps Script.** En la hoja: **Extensiones → Apps Script**. Borra lo que trae, pega todo `apps-script/Code.gs` y guarda.
   - Recarga la hoja: aparece el menú **Seguimiento de tareas → Instalar**. Ejecútalo y acepta los permisos (hoja, Drive para adjuntos, correo para avisos).
   - Crea las pestañas y programa la **tarea diaria de las 7 a. m.** (tareas recurrentes + avisos por correo).
3. **Publicar el script.** **Implementar → Nueva implementación → Aplicación web** · *Ejecutar como:* **Yo** · *Acceso:* **Cualquier usuario**. Copia la URL que termina en **`/exec`**.
4. **Conectar la página.** En `index.html` busca `PEGAR_AQUI_LA_URL_DEL_APPS_SCRIPT` y pon esa URL. Sube el cambio a GitHub.
5. **GitHub Pages.** **Settings → Pages → Branch: `main` / root → Save** → `https://rapiprestamos-prog.github.io/seguimiento-tareas/`.
6. **Primer ingreso.** La página detecta que no hay usuarios y te pide **crear la cuenta de administración** (tu usuario y tu contraseña; no queda escrita en ningún código).
7. **Tu equipo.** En **Usuarios y jerarquía** crea a cada persona con una contraseña temporal, su cargo y a quién reporta.

> Cada vez que cambies `Code.gs`: **Implementar → Gestionar implementaciones → editar → Versión: Nueva → Implementar** (la URL no cambia).

## Novedades (v5) · áreas y jefaturas
- **CEO ve todo:** el rol CEO ya no se limita a los jefes directos; ve a todas las personas activas.
- **Jefe ve toda su cadena:** si un supervisor de su área tiene gente a cargo, el jefe también la ve.
- **Resumen por área:** la vista de jefatura agrupa a la gente por área (Negocios, Operaciones, Tecnología…) con totales de abiertas, vencidas y completadas, y botones para filtrar un área. La barra lateral también agrupa por área.
- **Áreas sin duplicados:** al guardar una persona, si el área ya existe con otra escritura ("tecnologia", "TECNOLOGÍA") se usa la existente. Las áreas sugeridas se cambian en `AREAS_BASE` (en `Code.gs` y en `index.html`).
- La regla de quién ve qué la sigue aplicando el servidor (Apps Script).

## Novedades (v4)
- **Tablero por estatus (Kanban):** columnas Pendiente → Completado; se arrastran las tarjetas para cambiar el estatus (en celular, con el selector de cada tarjeta). Filtros por carpeta y prioridad.
- **Buscador rápido:** botón "Buscar tareas" o **Ctrl + K**. Busca por título, descripción, carpeta o persona (sin importar tildes) y abre la tarea con Enter.
- **Exportar a Excel:** menú de usuario → "Exportar tareas a Excel" (o el botón del tablero). Hoja "Tareas" con todas las columnas y hoja "Resumen".

## Cómo funcionan los permisos

- **Colaborador:** ve solo su tablero.
- **Jefe de área:** ve el suyo y el de toda su gente: sus directos y, si tiene supervisores, también los equipos de esos supervisores.
- **CEO (jefe general):** ve los tableros de todas las personas de todas las áreas, con un **Resumen general** agrupado por área.
- **Administración** maneja usuarios y jerarquía, pero **no ve tareas ajenas**. Por seguridad, quien administra **no puede ponerse como jefe de nadie ni subirse el rol**: eso lo hace otra persona administradora.
- Contraseñas cifradas; 5 intentos fallidos → 15 minutos de espera; contraseña temporal obliga a cambiarla; al cambiarla o asignar una nueva se cierran las otras sesiones.

## Rescate

Si alguien olvidó su contraseña y no hay otra persona administradora: en la hoja, menú **Seguimiento de tareas → Permitir que un usuario cree una contraseña nueva…** y luego esa persona entra con su usuario y crea una.
