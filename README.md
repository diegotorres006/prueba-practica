# CI/CD en la práctica: de un commit a producción

Este repositorio es el material de respaldo de la práctica en clase de **Sistemas Distribuidos — Despliegue de Aplicaciones**. Aquí vas a encontrar exactamente lo que viste hacer en el pizarrón (o en la pantalla del docente), pero explicado paso a paso, con el código completo y con la salida real que debería aparecerte a ti también si lo repites.

Úsalo así:

- Si viste la demo en clase y quieres repasar **por qué** cada comando hace lo que hace, lee de corrido.
- Si vas a **repetir la práctica tú mismo** (recomendado), sigue los pasos en orden y compara tu salida con la que se muestra aquí — si algo no coincide, esa diferencia normalmente ya te dice dónde está el problema.
- Si solo necesitas recordar un comando puntual, usa el índice.

## Índice

1. [¿Qué vas a construir?](#1-qué-vas-a-construir)
2. [Antes de empezar](#2-antes-de-empezar)
3. [Paso 1 — La aplicación: entender qué se está desplegando](#paso-1--la-aplicación-entender-qué-se-está-desplegando)
4. [Paso 2 — CI local: "fail fast" en tu propia máquina](#paso-2--ci-local-fail-fast-en-tu-propia-máquina)
5. [Paso 3 — Docker: el artefacto que no cambia](#paso-3--docker-el-artefacto-que-no-cambia)
6. [Paso 4 — El pipeline real en GitHub Actions](#paso-4--el-pipeline-real-en-github-actions)
7. [Paso 5 — Kubernetes: declarar el estado deseado](#paso-5--kubernetes-declarar-el-estado-deseado)
8. [Paso 6 — Rolling update: promover v1 a v2 sin apagar nada](#paso-6--rolling-update-promover-v1-a-v2-sin-apagar-nada)
9. [Paso 7 — Cuando algo sale mal: fallo simulado y rollback](#paso-7--cuando-algo-sale-mal-fallo-simulado-y-rollback)
10. [Glosario rápido](#10-glosario-rápido)
11. [Errores típicos (y por qué pasan)](#11-errores-típicos-y-por-qué-pasan)
12. [Preguntas para repasar](#12-preguntas-para-repasar)

---

## 1. ¿Qué vas a construir?

Una aplicación web mínima, empaquetada en una imagen Docker, desplegada en un clúster de Kubernetes, actualizada en vivo sin downtime, y recuperada automáticamente cuando un despliegue sale mal — todo disparado por un pipeline de CI/CD real en GitHub Actions.

No es un ejercicio abstracto: es el mismo viaje que recorre cualquier cambio de código en una empresa que usa CI/CD — **Commit → Build → Test → Package → Deploy → Monitor** — solo que aquí lo vas a ver completo, en una sola sesión, y vas a poder romperlo a propósito para entender por qué existen las salvaguardas.

```
tu commit → CI (build + test) → imagen Docker → Kubernetes (Dev/Staging/Prod) → usuarios reales
```

## 2. Antes de empezar

Necesitas: Docker Desktop corriendo, Node.js 20+, `kubectl`, Minikube, Git, y una cuenta de GitHub. Verifica que todo responde:

```bash
docker info
node -v
kubectl version --client
minikube version
git --version
```

Si alguno falla, instálalo antes de continuar — todo lo que sigue depende de que estas herramientas funcionen.

## Paso 1 — La aplicación: entender qué se está desplegando

Antes de automatizar nada, hay que entender **qué es lo que viaja** por el pipeline. Es una app Node.js/Express muy simple, con tres rutas:

| Ruta | Para qué sirve |
|---|---|
| `GET /health` | La usa Kubernetes para saber si el pod está sano. Si falla, Kubernetes deja de enviarle tráfico. |
| `GET /version` | Devuelve qué versión y qué color está corriendo ese pod específico — así vas a *ver* el rolling update en vivo. |
| `GET /` | Una página con el color de fondo de la versión activa, para proyectar en pantalla. |

**`server.js`**

```js
const express = require('express');
const os = require('os');

const APP_VERSION = process.env.APP_VERSION || 'v1';
const APP_COLOR = process.env.APP_COLOR || 'blue';
const SIMULATE_FAILURE = process.env.SIMULATE_FAILURE === 'true';

function createApp() {
  const app = express();

  app.get('/health', (req, res) => {
    if (SIMULATE_FAILURE) {
      return res.status(500).json({ status: 'error', reason: 'fallo simulado' });
    }
    res.status(200).json({ status: 'ok' });
  });

  app.get('/version', (req, res) => {
    res.status(200).json({
      version: APP_VERSION,
      color: APP_COLOR,
      hostname: os.hostname(),
    });
  });

  app.get('/', (req, res) => {
    res.status(200).send(
      '<html><body style="font-family: sans-serif; background:' + APP_COLOR +
      '; color:white; text-align:center; padding-top:80px;">' +
      '<h1>Sistemas Distribuidos - CI/CD</h1>' +
      '<h2>Version desplegada: ' + APP_VERSION + '</h2>' +
      '<p>Pod: ' + os.hostname() + '</p>' +
      '</body></html>'
    );
  });

  return app;
}

if (require.main === module) {
  const app = createApp();
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log('Servidor escuchando en puerto ' + PORT + ' (version=' + APP_VERSION + ', color=' + APP_COLOR + ')');
  });
}

module.exports = { createApp };
```

Fíjate que `APP_VERSION`, `APP_COLOR` y `SIMULATE_FAILURE` vienen de variables de entorno, no están escritos a mano en el código. Esto importa: significa que **la misma imagen** puede comportarse distinto según cómo la configures al arrancarla — el código no cambia entre entornos, solo su configuración externa. Es exactamente la idea que vas a usar en el Paso 3.

> 💡 **Por qué esto no es un detalle menor:** si `APP_VERSION` estuviera escrito directamente en el código (`"v1"` a secas), tendrías que editar el archivo y reconstruir la imagen cada vez que quisieras "cambiar de versión" para la demo. Al leerlo de una variable de entorno, la imagen es un artefacto neutral — configurable en tiempo de despliegue, no en tiempo de escritura de código.

## Paso 2 — CI local: "fail fast" en tu propia máquina

Antes de compartir tu código con nadie — antes incluso de construir una imagen — corre las pruebas. Este es el principio de **fail fast**: entre más temprano detectas un error, más barato es corregirlo.

```bash
npm install
npm test
```

**Esto es lo que deberías ver:**

```
> cicd-practica-sd@1.0.0 test
> node --test

✔ GET /health responde 200 y status ok (41.1ms)
✔ GET /version responde con version y color (6.6ms)
✔ GET / responde 200 con HTML (5.6ms)
ℹ tests 3
ℹ pass 3
ℹ fail 0
```

Tres pruebas, tres verificaciones básicas: que `/health` responda 200, que `/version` traiga los campos esperados, y que `/` devuelva HTML con el contenido correcto. Nada exótico — pero es exactamente lo que un pipeline de CI real corre por ti, automáticamente, en cada commit, para que nadie tenga que acordarse de hacerlo a mano.

> ⚠️ **Ojo:** estas mismas tres pruebas se van a volver a ejecutar dos veces más — dentro del `docker build` (Paso 3) y dentro de GitHub Actions (Paso 4). No es un error de diseño ni redundancia inútil: es el mismo gate de calidad puesto en tres lugares distintos, cada uno un poco más cerca de producción. Si algo se rompe, se detiene ahí — nunca avanza al siguiente entorno.

## Paso 3 — Docker: el artefacto que no cambia

Esta es la idea central de **"build once, promote many"**: la imagen se construye **una sola vez**, y esa misma imagen — sin recompilar — es la que viaja entre dev, staging y producción. Lo único que cambia entre entornos es la configuración externa (variables de entorno), nunca el código empaquetado.

**`Dockerfile`** (build multi-stage: una etapa para probar, otra para ejecutar)

```dockerfile
# --- Etapa 1: instalar dependencias y correr las pruebas (fail fast) ---
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm test

# --- Etapa 2: imagen final, minima, solo lo necesario para ejecutar ---
FROM node:20-alpine AS runtime
WORKDIR /app
ARG APP_VERSION=v1
ARG APP_COLOR=blue
ARG SIMULATE_FAILURE=false
ENV NODE_ENV=production
ENV APP_VERSION=$APP_VERSION
ENV APP_COLOR=$APP_COLOR
ENV SIMULATE_FAILURE=$SIMULATE_FAILURE
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/server.js ./server.js
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s CMD node -e "require('http').get('http://localhost:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
CMD ["node", "server.js"]
```

**¿Por qué dos etapas (`AS build` y `AS runtime`)?** La etapa `build` instala *todas* las dependencias (incluidas las de desarrollo) y corre las pruebas — si `npm test` falla aquí, `docker build` entero falla y jamás se genera una imagen. La etapa `runtime` arranca de cero, copia solo el código ya probado, e instala únicamente las dependencias de producción. El resultado es una imagen más chica y más segura — el código de las pruebas ni siquiera viaja dentro de ella.

Construye la imagen y pruébala:

```bash
docker build -t cicd-practica-sd:v1 \
  --build-arg APP_VERSION=v1 \
  --build-arg APP_COLOR=blue .

docker run -d --name cicd-demo -p 3000:3000 cicd-practica-sd:v1
curl -s http://localhost:3000/health
curl -s http://localhost:3000/version
```

**Salida real:**

```
--- /health ---
{"status":"ok"}
--- /version ---
{"version":"v1","color":"blue","hostname":"20f652d4f74d"}
```

`hostname` es el ID del contenedor — cuando más adelante tengas varios pods corriendo en Kubernetes, ese campo va a ser justamente lo que te permita distinguir a qué pod específico te respondió el `Service`.

Cuando termines de probar, limpia el contenedor:

```bash
docker rm -f cicd-demo
```

## Paso 4 — El pipeline real en GitHub Actions

Hasta ahora todo corrió en tu laptop. Esta parte es distinta: corre en los servidores de GitHub, dispara automáticamente con cada `push`, y es lo que verías si trabajaras en un equipo real donde nadie construye imágenes a mano.

**`.github/workflows/ci-cd.yml`**

```yaml
name: ci-cd

on:
  push:
    branches: [main]

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  build-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Instalar dependencias (build reproducible)
        run: npm ci

      - name: Ejecutar pruebas
        run: npm test

  build-push:
    needs: build-test
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4

      - name: Login en GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build y push de la imagen (build once, promote many)
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: |
            ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ github.sha }}
            ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:latest
```

Fíjate en dos líneas clave:

- **`needs: build-test`** — el job `build-push` declara una dependencia explícita: no arranca hasta que `build-test` termine con éxito. Esto es *fail fast* a nivel de pipeline completo: nunca se publica una imagen que no pasó sus pruebas.
- **`npm ci`** en vez de `npm install` — instala exactamente las versiones que dice el `package-lock.json`, sin sorpresas. Es lo que hace el build *reproducible*: la misma configuración produce siempre el mismo resultado.

Publica tu código y observa el pipeline correr:

```bash
git add .
git commit -m "CI/CD: app demo + Dockerfile + pipeline + manifiestos k8s"
git push -u origin main
```

Ve a la pestaña **Actions** del repositorio en GitHub. Vas a ver primero `build-test` corriendo (las mismas 3 pruebas del Paso 2), y cuando termina en verde, `build-push` arranca solo. Al final, en la pestaña **Packages**, aparece tu imagen publicada con dos etiquetas: el hash del commit y `latest`.

> 🤔 **¿Por qué no hay un job de "deploy" en este workflow?** Porque el clúster de Kubernetes de esta práctica (Minikube) corre en tu laptop — un servidor de GitHub en la nube no tiene forma de alcanzarlo. Por eso el paso final, el que realmente pone el cambio en "producción", lo hace una persona con `kubectl` en el Paso 6. Esa es, literalmente, la diferencia entre **Continuous Delivery** (todo queda listo, una persona aprieta el botón final) y **Continuous Deployment** (nadie aprieta nada, el propio pipeline decide). Aquí estás practicando el primero.

## Paso 5 — Kubernetes: declarar el estado deseado

Ya tienes una imagen probada y publicada. Ahora le vas a decir a Kubernetes **qué** quieres que exista (cuatro réplicas de esta imagen, expuestas en un servicio) y vas a dejar que Kubernetes se encargue del **cómo**.

```bash
minikube start --driver=docker
```

**`k8s/deployment.yaml`**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cicd-practica-sd
  labels:
    app: cicd-practica-sd
spec:
  replicas: 4
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
      maxSurge: 1
  selector:
    matchLabels:
      app: cicd-practica-sd
  template:
    metadata:
      labels:
        app: cicd-practica-sd
    spec:
      containers:
        - name: app
          image: ghcr.io/ctimbi/cicd-practica-sd:latest
          ports:
            - containerPort: 3000
          env:
            - name: PORT
              value: "3000"
          readinessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 2
            periodSeconds: 3
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 10
          resources:
            requests:
              cpu: "50m"
              memory: "64Mi"
            limits:
              cpu: "200m"
              memory: "128Mi"
```

Tres cosas para entender antes de aplicarlo:

- **`replicas: 4`** — cuatro copias del mismo pod corriendo en paralelo. Si una falla, las otras tres siguen sirviendo tráfico.
- **`maxUnavailable: 1` / `maxSurge: 1`** — durante una actualización, Kubernetes nunca tumba más de 1 pod viejo a la vez, y nunca crea más de 1 pod nuevo de más. Así el servicio nunca cae por debajo de 3 de 4 réplicas sanas, aunque estés actualizando en pleno tráfico.
- **`readinessProbe`** — antes de que un pod nuevo reciba una sola petición de un usuario real, Kubernetes le pregunta a `/health`. Si no responde 200, el pod se queda "no listo" y el `Service` jamás le manda tráfico. Esto es lo que va a proteger la práctica del Paso 7.

**`k8s/service.yaml`**

```yaml
apiVersion: v1
kind: Service
metadata:
  name: cicd-practica-sd
spec:
  type: NodePort
  selector:
    app: cicd-practica-sd
  ports:
    - port: 80
      targetPort: 3000
```

El `Service` es el balanceador: reparte cada petición entrante entre todos los pods que estén "listos" (`Ready`) en ese momento — nunca a mano, siempre según el estado real que reporta el `readinessProbe`.

Aplica y verifica:

```bash
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
kubectl rollout status deployment/cicd-practica-sd
```

**Salida real:**

```
deployment.apps/cicd-practica-sd created
service/cicd-practica-sd created
Waiting for deployment "cicd-practica-sd" rollout to finish: 0 of 4 updated replicas are available...
Waiting for deployment "cicd-practica-sd" rollout to finish: 1 of 4 updated replicas are available...
Waiting for deployment "cicd-practica-sd" rollout to finish: 2 of 4 updated replicas are available...
Waiting for deployment "cicd-practica-sd" rollout to finish: 3 of 4 updated replicas are available...
deployment "cicd-practica-sd" successfully rolled out
```

Expón el servicio y pruébalo:

```bash
minikube service cicd-practica-sd --url
# copia la URL que imprime, por ejemplo http://127.0.0.1:50562
curl -s http://127.0.0.1:50562/version
```

## Paso 6 — Rolling update: promover v1 a v2 sin apagar nada

Este es el momento en que "algo cambió en el código" se convierte en "los usuarios ya están usando la versión nueva" — sin que nadie haya notado una interrupción.

En un flujo real, esto arranca con un cambio de código de verdad: editas `server.js`, haces `commit` y `push`, GitHub Actions construye y publica la nueva imagen con un tag nuevo (el hash del commit), y tú promueves ese tag. Aquí, para verlo en vivo sin depender de internet en el salón, construimos una `v2` explícita:

```bash
docker build -t cicd-practica-sd:v2 \
  --build-arg APP_VERSION=v2 \
  --build-arg APP_COLOR=green .

minikube image load cicd-practica-sd:v2
```

Y ahora, el comando que realmente dispara el cambio — el "botón final" del que hablábamos en el Paso 4:

```bash
kubectl set image deployment/cicd-practica-sd app=cicd-practica-sd:v2
kubectl rollout status deployment/cicd-practica-sd
```

**Salida real — observa el reemplazo gradual, nunca todo de golpe:**

```
deployment.apps/cicd-practica-sd image updated
Waiting for deployment "cicd-practica-sd" rollout to finish: 0 out of 4 new replicas have been updated...
Waiting for deployment "cicd-practica-sd" rollout to finish: 1 out of 4 new replicas have been updated...
Waiting for deployment "cicd-practica-sd" rollout to finish: 2 out of 4 new replicas have been updated...
Waiting for deployment "cicd-practica-sd" rollout to finish: 3 out of 4 new replicas have been updated...
Waiting for deployment "cicd-practica-sd" rollout to finish: 1 old replicas are pending termination...
Waiting for deployment "cicd-practica-sd" rollout to finish: 3 of 4 updated replicas are available...
deployment "cicd-practica-sd" successfully rolled out
```

Confirma que el `Service` ahora reparte entre pods nuevos, distintos entre sí:

```bash
for i in 1 2 3 4 5 6 7 8; do curl -s http://127.0.0.1:50562/version; echo; done
```

**Salida real (8 peticiones seguidas, mira el campo `hostname`):**

```
{"version":"v2","color":"green","hostname":"cicd-practica-sd-c48c44648-rxltk"}
{"version":"v2","color":"green","hostname":"cicd-practica-sd-c48c44648-4zr96"}
{"version":"v2","color":"green","hostname":"cicd-practica-sd-c48c44648-4c2gq"}
{"version":"v2","color":"green","hostname":"cicd-practica-sd-c48c44648-rxltk"}
{"version":"v2","color":"green","hostname":"cicd-practica-sd-c48c44648-4zr96"}
{"version":"v2","color":"green","hostname":"cicd-practica-sd-c48c44648-86tph"}
{"version":"v2","color":"green","hostname":"cicd-practica-sd-c48c44648-4c2gq"}
{"version":"v2","color":"green","hostname":"cicd-practica-sd-c48c44648-86tph"}
```

Cuatro `hostname` distintos respondiendo, todos en `v2` — el `Service` está balanceando entre las 4 réplicas nuevas. En ningún momento de todo este proceso el servicio dejó de responder: eso es lo que significa "downtime cercano a cero" cuando hablamos de rolling update.

## Paso 7 — Cuando algo sale mal: fallo simulado y rollback

Ahora la parte que casi nunca se practica en un curso, pero es la más importante en producción: ¿qué pasa cuando el despliegue que acabas de promover está roto?

Construimos una tercera imagen cuya variable `SIMULATE_FAILURE=true` hace que `/health` responda siempre `500`:

```bash
docker build -t cicd-practica-sd:v3-roto \
  --build-arg APP_VERSION=v3-roto \
  --build-arg APP_COLOR=red \
  --build-arg SIMULATE_FAILURE=true .

minikube image load cicd-practica-sd:v3-roto
```

La promovemos igual que en el Paso 6:

```bash
kubectl set image deployment/cicd-practica-sd app=cicd-practica-sd:v3-roto
kubectl rollout status deployment/cicd-practica-sd --timeout=20s
```

**Salida real — el rollout nunca termina, se queda esperando:**

```
deployment.apps/cicd-practica-sd image updated
Waiting for deployment "cicd-practica-sd" rollout to finish: 2 out of 4 new replicas have been updated...
error: timed out waiting for the condition
```

`kubectl get events` explica por qué:

```
Warning  Unhealthy  Readiness probe failed: HTTP probe failed with statuscode: 500
Warning  Unhealthy  Liveness probe failed: HTTP probe failed with statuscode: 500
```

**Esta es la parte que hay que entender bien:** los pods nuevos (rotos) nunca llegan a estar "listos", así que el `Service` **nunca les manda tráfico**. Compruébalo:

```bash
curl -s http://127.0.0.1:50562/version
```

```
{"version":"v2","color":"green","hostname":"cicd-practica-sd-c48c44648-qrwnq"}
```

Sigue respondiendo `v2` — la versión buena. El `readinessProbe` combinado con `maxUnavailable: 1` ya limitó el daño: como máximo 1 de las 4 réplicas buenas se sacrificó para probar la versión nueva, y esa réplica dañada jamás recibió tráfico real. Esta es la idea que conecta todo el curso: **la mejor forma de tolerar una falla es nunca haber expuesto a todos los usuarios a ella.**

Ahora sí, revertimos:

```bash
kubectl rollout undo deployment/cicd-practica-sd
kubectl rollout status deployment/cicd-practica-sd
```

**Salida real:**

```
deployment.apps/cicd-practica-sd rolled back
Waiting for deployment "cicd-practica-sd" rollout to finish: 3 out of 4 new replicas have been updated...
Waiting for deployment "cicd-practica-sd" rollout to finish: 3 of 4 updated replicas are available...
deployment "cicd-practica-sd" successfully rolled out
```

```bash
for i in 1 2 3 4; do curl -s http://127.0.0.1:50562/version; echo; done
```

```
{"version":"v2","color":"green","hostname":"cicd-practica-sd-c48c44648-qrwnq"}
{"version":"v2","color":"green","hostname":"cicd-practica-sd-c48c44648-qrwnq"}
{"version":"v2","color":"green","hostname":"cicd-practica-sd-c48c44648-qrwnq"}
{"version":"v2","color":"green","hostname":"cicd-practica-sd-c48c44648-qrwnq"}
```

De vuelta a `v2`, servicio sano. Todo esto — desplegar, detectar el fallo, y revertir — pasó sin que ningún usuario real recibiera un error, y sin que nadie tuviera que reconstruir nada a mano: `kubectl rollout undo` simplemente le dice a Kubernetes "vuelve a la revisión anterior de este `Deployment`".

> ⚠️ **Un detalle importante que aprendimos probando esta misma guía:** `kubectl rollout undo`, sin más argumentos, revierte solo la **última revisión**, no necesariamente "la última versión que sabías que funcionaba". Cada `kubectl set image` o `kubectl set env` que cambie la plantilla del pod crea una revisión nueva. Si acumulas varios cambios sueltos antes de descubrir el problema, un solo `undo` puede dejarte en un punto intermedio, no en el bueno. La forma segura de revisar esto es:
>
> ```bash
> kubectl rollout history deployment/cicd-practica-sd
> kubectl rollout undo deployment/cicd-practica-sd --to-revision=N
> ```

## 10. Glosario rápido

| Término | En una frase |
|---|---|
| **CI (Integración Continua)** | Compilar y probar automáticamente cada cambio, antes de que se junte con el de los demás. |
| **CD** | Ambiguo a propósito: *Continuous Delivery* = queda listo, una persona aprueba el paso final. *Continuous Deployment* = se despliega solo, sin aprobación humana. |
| **Artefacto** | El resultado empaquetado y versionado de un build — aquí, la imagen Docker. |
| **Registry** | Donde se publican las imágenes versionadas (aquí, `ghcr.io`). |
| **Pipeline as code** | La definición del pipeline vive como archivo (`ci-cd.yml`) dentro del propio repositorio, versionada igual que el código. |
| **Rolling update** | Reemplazar instancias viejas por nuevas de a poco, nunca todas de golpe. |
| **Readiness probe** | Pregunta que Kubernetes le hace a un pod para saber si ya puede recibir tráfico. |
| **Liveness probe** | Pregunta que Kubernetes le hace a un pod para saber si sigue vivo (si no responde, lo reinicia). |
| **Rollback** | Volver a la versión anterior de un despliegue cuando la nueva falla. |
| **Fail fast** | Detener el pipeline en el primer paso que falle, en vez de seguir gastando tiempo (y arriesgando producción) más adelante. |

## 11. Errores típicos (y por qué pasan)

Estos tres problemas ocurrieron de verdad al preparar esta práctica — se documentan porque son más instructivos que cualquier explicación teórica sobre "por qué hay que probar el pipeline":

**"Pasé `--build-arg` pero la imagen no cambió."**
Docker no da error si le pasas un `--build-arg` que el `Dockerfile` no declaró con `ARG` — simplemente lo ignora. Si tu `Dockerfile` no tiene la línea `ARG APP_VERSION=v1` (y las demás), tu variable nunca llega a la imagen. Revisa siempre que cada `--build-arg` tenga su `ARG` correspondiente.

**"Reconstruí la imagen pero Minikube sigue usando la vieja."**
Minikube puede cachear una imagen por su nombre de tag y no reemplazarla al volver a hacer `minikube image load` con el mismo tag. Si esto te pasa: `minikube ssh -- docker rmi -f <tag>` y vuelve a cargarla. La forma de evitarlo del todo: usa un tag distinto cada vez (el pipeline real lo hace con el hash del commit, nunca reutiliza `latest` para verificar un cambio específico).

**"Hice rollback pero no volvió a la versión que esperaba."**
Como se explica en el Paso 7: cada cambio a la plantilla del pod (imagen, variables de entorno) crea una revisión nueva. `kubectl rollout undo` sin argumentos deshace solo una. Usa `kubectl rollout history` para ver todas las revisiones antes de decidir a cuál volver.

## 12. Preguntas para repasar

1. ¿Por qué el `Dockerfile` corre `npm test` dentro del build, si ya corriste `npm test` a mano en el Paso 2? ¿No es repetir el mismo trabajo dos veces?
2. En el Paso 6, ¿qué hubiera pasado si `maxUnavailable` fuera igual a `4` (el total de réplicas) en vez de `1`?
3. El pipeline de este ejercicio no tiene ninguna aprobación humana antes de llegar a Kubernetes — apenas pasa CI, tú mismo ejecutas `kubectl set image`. ¿Eso lo convierte en *Continuous Delivery* o en *Continuous Deployment*? ¿Por qué?
4. En el Paso 7, ¿qué pasó exactamente con el pod que se quedó a medio actualizar (`0/1 Running`, pero nunca `Ready`)? ¿Por qué Kubernetes no lo mató inmediatamente?
5. Si en vez de `readinessProbe` el `Deployment` no tuviera ningún probe configurado, ¿el `Service` se habría dado cuenta de que la `v3-roto` estaba fallando? ¿Qué habrían visto los usuarios?
