# ia-tooling

Utilidades para trabajar con agentes de IA.

## reconstruir-sesion.mjs

Reconstruye, paso a paso, lo que hizo un agente de *Antigravity* en una sesión, a partir de los registros que la propia herramienta guarda en disco.

Lo escribí para el artículo [Modelo, motor y agente: dónde actuar cuando algo falla](https://elartesanodelbyte.com/desarrollo-asistido-por-ia/modelo-motor-agente/). Necesitaba separar qué hizo el modelo, qué hizo el motor y qué venía de mi configuración, sin navegar entre decenas de directorios con nombres de hash.

### Uso

Requiere Node.js >= 22.13. No tiene dependencias.

Desde el directorio que contiene `brain/` y `conversations/` (normalmente `~/.gemini/antigravity`), o indicándolo con `--root`:

```sh
node reconstruir-sesion.mjs --list
node reconstruir-sesion.mjs mi-proyecto --full --out informe.md
node reconstruir-sesion.mjs --id 1a2b3c4d --full --thinking --out sesion.md
node reconstruir-sesion.mjs --help
```

El script abre las bases de datos en solo lectura y no lee registros fuera de la raíz indicada.

### Antes de usarlo

- **Cómo está hecho.** De forma pragmática, con *vibe coding*, iterando hasta que el informe me daba lo que buscaba. Los extractos que cito en el artículo los contrasté con la base de datos de cada sesión, no solo con el informe.
- **Extracción dirigida.** *Antigravity* guarda cada paso como un mensaje protobuf cuyo esquema no publica. El script reconoce los campos por su contenido y solo extrae lo que fui a buscar, no todo lo que hay en el registro.
- **Probado solo con mis registros de *Antigravity 2.0*.** Una nueva versión de *Antigravity* puede cambiar la forma en que registra su funcionamiento. Cada informe incluye una sección que contrasta los supuestos del script con el propio volcado y muestra los que dejan de cumplirse.
- **Sin mantenimiento.** Lo publico tal cual.
- **Privacidad.** El informe copia lo que vio el agente: rutas, salidas de comandos y contenido de ficheros. Conviene revisarlo antes de compartirlo.

## GEMINI.md

Reglas globales para *Antigravity* (`~/.gemini/config/GEMINI.md`): un bloque de estado al inicio de cada respuesta, pautas de entorno y una política para delegar en subagentes. Son instrucciones que el modelo lee y decide cumplir, es decir, un control blando: no impiden que el modelo actúe de otra forma. No he comprobado que basten.

## Licencia

MIT. Ver [LICENSE](LICENSE).
