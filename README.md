# CI/CD en la práctica: de un commit a producción

Este repositorio es el material de respaldo de la práctica en clase de **Sistemas Distribuidos — Despliegue de Aplicaciones**. Aquí encontrará exactamente lo que se mostró en clase,  explicado paso a paso, con el código completo y con la salida de referencia que debería obtener.


## Índice

1. [¿Qué se va a construir?](#1-qué-se-va-a-construir)
2. [Antes de empezar](#2-antes-de-empezar)
3. [Paso 1 — La aplicación: entender qué se está desplegando](#paso-1--la-aplicación-entender-qué-se-está-desplegando)
4. [Paso 2 — CI local: "fail fast" en su propia máquina](#paso-2--ci-local-fail-fast-en-su-propia-máquina)
5. [Paso 3 — Docker: el artefacto que no cambia](#paso-3--docker-el-artefacto-que-no-cambia)
6. [Paso 4 — El pipeline real en GitHub Actions](#paso-4--el-pipeline-real-en-github-actions)
7. [Paso 5 — Kubernetes: declarar el estado deseado](#paso-5--kubernetes-declarar-el-estado-deseado)
8. [Paso 6 — Rolling update: promover un cambio real sin apagar nada](#paso-6--rolling-update-promover-un-cambio-real-sin-apagar-nada)
9. [Paso 7 — Cuando algo sale mal: fallo simulado y rollback](#paso-7--cuando-algo-sale-mal-fallo-simulado-y-rollback)
10. [Glosario rápido](#10-glosario-rápido)
11. [Errores típicos (y por qué ocurren)](#11-errores-típicos-y-por-qué-ocurren)
12. [Preguntas para repasar](#12-preguntas-para-repasar)

---

## 1. ¿Qué se va a construir?

Una aplicación web mínima, empaquetada en una imagen Docker, desplegada en un clúster de Kubernetes, actualizada en vivo sin downtime, y recuperada automáticamente cuando un despliegue sale mal — todo disparado por un pipeline de CI/CD real en GitHub Actions.

No es un ejercicio abstracto: es el mismo recorrido que hace cualquier cambio de código en una empresa que usa CI/CD — **Commit → Build → Test → Package → Deploy → Monitor** — solo que aquí lo va a ver completo, en una sola sesión, y va a poder romperlo a propósito para entender por qué existen las salvaguardas.

```
su commit → CI (build + test) → imagen Docker → Kubernetes (Dev/Staging/Prod) → usuarios reales
```

## 2. Antes de empezar

Se necesita: Docker Desktop en ejecución, Node.js 20+, `kubectl`, Minikube, Git, y una cuenta de GitHub. Verifique que todo responda correctamente:

```bash
docker info
node -v
kubectl version --client
minikube version
git --version
```

Si algo falla, instálelo antes de continuar — todo lo que sigue depende de que estas herramientas funcionen.

## Paso 1 — La aplicación: entender qué se está desplegando

Antes de automatizar nada, conviene entender **qué es lo que viaja** por el pipeline. Se trata de una app Node.js/Express muy simple, con tres rutas:

| Ruta | Para qué sirve |
|---|---|
| `GET /health` | La usa Kubernetes para saber si el pod está sano. Si falla, Kubernetes deja de enviarle tráfico. |
| `GET /version` | Devuelve qué versión y qué color está corriendo ese pod específico — así se va a *ver* el rolling update en vivo. |
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

Observe que `APP_VERSION`, `APP_COLOR` y `SIMULATE_FAILURE` provienen de variables de entorno, no están escritos a mano en el código. Esto es importante: significa que **la misma imagen** puede comportarse distinto según cómo se configure al arrancarla — el código no cambia entre entornos, solo su configuración externa. Es exactamente la idea que se va a usar en el Paso 3.

> 💡 **Por qué esto no es un detalle menor:** si `APP_VERSION` estuviera escrito directamente en el código (`"v1"` a secas), habría que editar el archivo y reconstruir la imagen cada vez que se quisiera "cambiar de versión" para la demo. Al leerlo de una variable de entorno, la imagen es un artefacto neutral — configurable en tiempo de despliegue, no en tiempo de escritura de código.

## Paso 2 — CI local: "fail fast" en su propia máquina

Antes de compartir el código con nadie — antes incluso de construir una imagen — ejecute las pruebas. Este es el principio de **fail fast**: entre más temprano se detecta un error, más barato resulta corregirlo.

```bash
npm install
npm test
```

**Esto es lo que debería ver:**

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

Tres pruebas, tres verificaciones básicas: que `/health` responda 200, que `/version` traiga los campos esperados, y que `/` devuelva HTML con el contenido correcto. Nada exótico — pero es exactamente lo que un pipeline de CI real ejecuta automáticamente, en cada commit, para que nadie tenga que acordarse de hacerlo a mano.

> ⚠️ **Nota:** estas mismas tres pruebas se van a volver a ejecutar dos veces más — dentro del `docker build` (Paso 3) y dentro de GitHub Actions (Paso 4). No es un error de diseño ni redundancia inútil: es el mismo control de calidad puesto en tres lugares distintos, cada uno un poco más cerca de producción. Si algo se rompe, se detiene ahí — nunca avanza al siguiente entorno.

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

**¿Por qué dos etapas (`AS build` y `AS runtime`)?** La etapa `build` instala *todas* las dependencias (incluidas las de desarrollo) y ejecuta las pruebas — si `npm test` falla aquí, `docker build` entero falla y jamás se genera una imagen. La etapa `runtime` arranca de cero, copia solo el código ya probado, e instala únicamente las dependencias de producción. El resultado es una imagen más pequeña y más segura — el código de las pruebas ni siquiera viaja dentro de ella.

Construya la imagen y pruébela:

```bash
docker build -t cicd-practica-sd:v1 \
  --build-arg APP_VERSION=v1 \
  --build-arg APP_COLOR=blue .

docker run -d --name cicd-demo -p 3000:3000 cicd-practica-sd:v1
curl -s http://localhost:3000/health
curl -s http://localhost:3000/version
```

**Ejemplo de salida:**

```
--- /health ---
{"status":"ok"}
--- /version ---
{"version":"v1","color":"blue","hostname":"20f652d4f74d"}
```

`hostname` es el ID del contenedor — cuando más adelante haya varios pods corriendo en Kubernetes, ese campo será justamente lo que permita distinguir a qué pod específico respondió el `Service`.

Al terminar de probar, limpie el contenedor:

```bash
docker rm -f cicd-demo
```

## Paso 4 — El pipeline real en GitHub Actions

Hasta ahora todo corrió en su laptop. Esta parte es distinta: corre en los servidores de GitHub, se dispara automáticamente con cada `push`, y es lo que se vería en un equipo real donde nadie construye imágenes a mano.

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

Observe dos líneas clave:

- **`needs: build-test`** — el job `build-push` declara una dependencia explícita: no arranca hasta que `build-test` termine con éxito. Esto es *fail fast* a nivel de pipeline completo: nunca se publica una imagen que no pasó sus pruebas.
- **`npm ci`** en vez de `npm install` — instala exactamente las versiones que indica el `package-lock.json`, sin sorpresas. Es lo que hace el build *reproducible*: la misma configuración produce siempre el mismo resultado.

Antes del primer `push`, cree un repositorio vacío en GitHub (público, para que el paquete de `ghcr.io` quede accesible sin credenciales) y conéctelo:

```bash
git init          # si todavía no lo hizo
git branch -M main
git remote add origin https://github.com/<su-usuario>/cicd-practica-sd.git
```

Y ahora sí, publique el código y observe el pipeline correr:

```bash
git add .
git commit -m "CI/CD: app demo + Dockerfile + pipeline + manifiestos k8s"
git push -u origin main
```

Vaya a la pestaña **Actions** del repositorio en GitHub. Se verá primero `build-test` corriendo (las mismas 3 pruebas del Paso 2), y cuando termina en verde, `build-push` arranca solo. Al final, en la pestaña **Packages**, aparece la imagen publicada con dos etiquetas: el hash del commit y `latest`.

> 🤔 **¿Por qué no hay un job de "deploy" en este workflow?** Porque el clúster de Kubernetes de esta práctica (Minikube) corre en su laptop — un servidor de GitHub en la nube no tiene forma de alcanzarlo. Por eso el paso final, el que realmente pone el cambio en "producción", lo ejecuta una persona con `kubectl` en el Paso 6. Esa es, literalmente, la diferencia entre **Continuous Delivery** (todo queda listo, una persona aprieta el botón final) y **Continuous Deployment** (nadie aprieta nada, el propio pipeline decide). Aquí se está practicando el primero.

## Paso 5 — Kubernetes: declarar el estado deseado

Ya se cuenta con una imagen probada y publicada. Ahora se le va a indicar a Kubernetes **qué** debe existir (cuatro réplicas de esta imagen, expuestas en un servicio) y se dejará que Kubernetes se encargue del **cómo**.

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
          image: ghcr.io/<su-usuario>/cicd-practica-sd:latest
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
- **`maxUnavailable: 1` / `maxSurge: 1`** — durante una actualización, Kubernetes nunca retira más de 1 pod viejo a la vez, y nunca crea más de 1 pod nuevo de más. Así el servicio nunca cae por debajo de 3 de 4 réplicas sanas, incluso mientras se actualiza en pleno tráfico.
- **`readinessProbe`** — antes de que un pod nuevo reciba una sola petición de un usuario real, Kubernetes le consulta a `/health`. Si no responde 200, el pod se queda "no listo" y el `Service` jamás le envía tráfico. Esto es lo que va a proteger la práctica del Paso 7.

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

**Antes de aplicar**, abra `k8s/deployment.yaml` y reemplace `<su-usuario>` por su usuario real de GitHub (el mismo que usó en el Paso 4) — si la imagen todavía no existe en `ghcr.io` porque aún no se ha hecho el primer `push`, hágalo primero (Paso 4) y vuelva aquí.

Aplique y verifique:

```bash
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
kubectl rollout status deployment/cicd-practica-sd
```

**Ejemplo de salida** (los tiempos y el orden exacto de las líneas pueden variar un poco en cada máquina, pero debe terminar igual):

```
deployment.apps/cicd-practica-sd created
service/cicd-practica-sd created
Waiting for deployment "cicd-practica-sd" rollout to finish: 0 of 4 updated replicas are available...
Waiting for deployment "cicd-practica-sd" rollout to finish: 1 of 4 updated replicas are available...
Waiting for deployment "cicd-practica-sd" rollout to finish: 2 of 4 updated replicas are available...
Waiting for deployment "cicd-practica-sd" rollout to finish: 3 of 4 updated replicas are available...
deployment "cicd-practica-sd" successfully rolled out
```

Exponga el servicio. Minikube asignará un puerto local aleatorio, así que en vez de escribirlo a mano cada vez, guárdelo en una variable — se va a reutilizar en los pasos 6 y 7:

```bash
export URL=$(minikube service cicd-practica-sd --url)
echo "La aplicacion esta en: $URL"
curl -s $URL/version
```

> 💡 Cada vez que abra una terminal nueva (por ejemplo, si retoma esta práctica otro día), vuelva a ejecutar `export URL=$(minikube service cicd-practica-sd --url)` — esa variable no persiste entre sesiones de terminal.

## Paso 6 — Rolling update: promover un cambio real sin apagar nada

Este es el momento en que "algo cambió en el código" se convierte en "los usuarios ya están usando la versión nueva" — sin que nadie haya notado una interrupción. A diferencia de los pasos anteriores, aquí **no se construye nada en la laptop**: la imagen ya la construyó y publicó GitHub Actions cuando se hizo `push` en el Paso 4.

### 6.1 Cambiar algo de verdad y publicarlo

Edite `server.js` (o el `Dockerfile`, si desea cambiar los valores por defecto de `APP_VERSION`/`APP_COLOR`), y súbalo:

```bash
git add server.js
git commit -m "cambiar titulo de la app"
git push
```

Vaya a la pestaña **Actions** del repositorio y espere a que el run termine en verde. Cuando termine, obtenga el hash exacto de **su** commit:

```bash
git log -1 --format=%H
```

Se obtendrá un hash largo, único para ese commit (algo como `2f7caf511e0656923ef202790494cfff33ead0bd`, pero el suyo será distinto) — es el mismo hash con el que GitHub Actions etiquetó la imagen nueva en `ghcr.io`. Guárdelo también en una variable, para no tener que copiarlo a mano en cada comando:

```bash
export SHA=$(git log -1 --format=%H)
echo "La imagen nueva es: ghcr.io/<su-usuario>/cicd-practica-sd:$SHA"
```

> 💡 **Importante:** el workflow de esta práctica *no* pasa `--build-arg` al construir la imagen (véase el `docker/build-push-action@v5` del Paso 4) — así que si se desea que `/version` también cambie visualmente, no basta con cambiar `server.js`; también hay que cambiar los valores por defecto `ARG APP_VERSION=...` / `ARG APP_COLOR=...` del `Dockerfile` y subir ese cambio junto con el resto. Lo que sí cambia siempre, pase lo que pase, es el hash del commit — y por eso es el hash, no un tag inventado como `v2`, lo que identifica de verdad una versión en el flujo real.

### 6.2 Promover el cambio (el botón final de Continuous Delivery)

Con el hash y la URL guardados en variables, este es el comando que realmente dispara el cambio en el clúster:

```bash
kubectl set image deployment/cicd-practica-sd app=ghcr.io/<su-usuario>/cicd-practica-sd:$SHA
kubectl rollout status deployment/cicd-practica-sd
```

**Ejemplo de salida — obsérvese el reemplazo gradual, nunca todo de golpe (los nombres de pod serán distintos en cada clúster):**

```
deployment.apps/cicd-practica-sd image updated
Waiting for deployment "cicd-practica-sd" rollout to finish: 2 out of 4 new replicas have been updated...
Waiting for deployment "cicd-practica-sd" rollout to finish: 3 out of 4 new replicas have been updated...
Waiting for deployment "cicd-practica-sd" rollout to finish: 1 old replicas are pending termination...
Waiting for deployment "cicd-practica-sd" rollout to finish: 3 of 4 updated replicas are available...
deployment "cicd-practica-sd" successfully rolled out
```

Confirme que el `Service` ahora reparte entre pods nuevos, ya con el código actualizado:

```bash
curl -s $URL/version; echo
curl -s $URL/ | grep -o '<h1>.*</h1>'
```

**Debería verse reflejado el cambio propio**, por ejemplo (esto es solo ilustrativo — lo que importa es que aparezca *su* edición, no este texto exacto):

```
{"version":"v1","color":"blue","hostname":"cicd-practica-sd-6d768bd548-2mvpj"}
<h1>Sistemas Distribuidos - (aquí el cambio realizado)</h1>
```

Kubernetes no sabe (ni le importa) que ese contenido cambió — solo sabe que se le entregó un nuevo `image:` y que la actualización nueva pasó el `readinessProbe`. En ningún momento de todo este proceso el `Service` dejó de responder: eso es lo que significa "downtime cercano a cero" cuando se habla de rolling update.

<details>
<summary><strong>Plan B — si no hay internet en el salón (sin GitHub Actions)</strong></summary>

Si por alguna razón no se puede depender de internet durante la práctica, se puede simular el mismo mecanismo construyendo y cargando la imagen directamente en Minikube, sin pasar por `ghcr.io`:

```bash
docker build -t cicd-practica-sd:v2 \
  --build-arg APP_VERSION=v2 \
  --build-arg APP_COLOR=green .

minikube image load cicd-practica-sd:v2

kubectl set image deployment/cicd-practica-sd app=cicd-practica-sd:v2
kubectl rollout status deployment/cicd-practica-sd
```

La mecánica de Kubernetes (rolling update, probes, balanceo) es idéntica — lo único que cambia es de dónde proviene la imagen. Véase la sección de errores típicos si Minikube no reemplaza una imagen con un tag ya usado.

</details>

## Paso 7 — Cuando algo sale mal: fallo simulado y rollback

Ahora la parte que casi nunca se practica en un curso, pero es la más importante en producción: ¿qué ocurre cuando el despliegue que se acaba de promover está roto? Y otra vez, esto se hace con un commit real, no con una imagen local.

### 7.1 Romper el despliegue a propósito (con un commit real)

En el `Dockerfile`, cambie el valor por defecto de `ARG SIMULATE_FAILURE` a `true` — eso hace que `/health` responda siempre `500`:

```dockerfile
ARG APP_VERSION=v3-roto
ARG APP_COLOR=red
ARG SIMULATE_FAILURE=true
```

Suba el cambio y espere a que el pipeline termine. Guarde también este hash en una variable (distinta a `$SHA` del paso anterior, para no perder la referencia a la versión buena):

```bash
git add Dockerfile
git commit -m "Simular despliegue fallido (SIMULATE_FAILURE=true) para practica de rollback"
git push
export SHA_BUENO=$SHA              # la version que se sabe que funciona (Paso 6)
export SHA_ROTO=$(git log -1 --format=%H)   # el commit recien subido, roto a proposito
```

> 💡 Conviene dejar este commit "roto" en el historial — no hace falta revertirlo después. Es justo el commit que sirve para repetir este ejercicio de rollback cuantas veces se necesite, sin tener que volver a romper nada.

### 7.2 Promover la imagen rota y observar el rollout atascarse

```bash
kubectl set image deployment/cicd-practica-sd app=ghcr.io/<su-usuario>/cicd-practica-sd:$SHA_ROTO
kubectl rollout status deployment/cicd-practica-sd --timeout=25s
```

**Ejemplo de salida — el rollout nunca termina, se queda esperando:**

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

**Esta es la parte que hay que entender bien:** los pods nuevos (rotos) nunca llegan a estar "listos", así que el `Service` **nunca les envía tráfico**. Compruébelo:

```bash
curl -s $URL/version
```

Debería seguir viéndose la versión buena (la de antes del commit roto), servida desde uno de los pods que nunca se tocaron. El `readinessProbe` combinado con `maxUnavailable: 1` ya limitó el daño: como máximo 1 de las 4 réplicas buenas se sacrificó para probar la versión nueva, y esa réplica dañada jamás recibió tráfico real. Esta es la idea que conecta todo el curso: **la mejor forma de tolerar una falla es nunca haber expuesto a todos los usuarios a ella.**

### 7.3 Ejecutar el rollback

```bash
kubectl rollout undo deployment/cicd-practica-sd
kubectl rollout status deployment/cicd-practica-sd
```

**Ejemplo de salida:**

```
deployment.apps/cicd-practica-sd rolled back
Waiting for deployment "cicd-practica-sd" rollout to finish: 3 out of 4 new replicas have been updated...
Waiting for deployment "cicd-practica-sd" rollout to finish: 3 of 4 updated replicas are available...
deployment "cicd-practica-sd" successfully rolled out
```

```bash
curl -s $URL/version
```

Confirme que se volvió a ver la versión buena. Todo esto — desplegar la imagen real que construyó el propio pipeline, detectar el fallo, y revertir — ocurrió sin que ningún usuario real recibiera un error, y sin que nadie tuviera que reconstruir nada a mano: `kubectl rollout undo` simplemente le indica a Kubernetes "vuelva a la revisión anterior de este `Deployment`".

<details>
<summary><strong>Plan B — versión con imagen local (sin depender de internet)</strong></summary>

```bash
docker build -t cicd-practica-sd:v3-roto \
  --build-arg APP_VERSION=v3-roto \
  --build-arg APP_COLOR=red \
  --build-arg SIMULATE_FAILURE=true .

minikube image load cicd-practica-sd:v3-roto

kubectl set image deployment/cicd-practica-sd app=cicd-practica-sd:v3-roto
kubectl rollout status deployment/cicd-practica-sd --timeout=20s
# ... mismo comportamiento: se atasca, y se revierte con kubectl rollout undo
```

</details>

> ⚠️ **Un detalle importante, detectado al validar esta misma guía:** `kubectl rollout undo`, sin más argumentos, revierte solo la **última revisión**, no necesariamente "la última versión que se sabía que funcionaba". Cada `kubectl set image` o `kubectl set env` que cambie la plantilla del pod crea una revisión nueva. Si se acumulan varios cambios sueltos antes de descubrir el problema, un solo `undo` puede dejar el despliegue en un punto intermedio, no en el bueno. La forma segura de revisar esto es:
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

## 11. Errores típicos (y por qué ocurren)

Estos problemas ocurrieron de verdad al preparar esta práctica — se documentan porque son más instructivos que cualquier explicación teórica sobre "por qué hay que probar el pipeline":

**"Se cambió `server.js` pero `/version` sigue mostrando lo mismo."**
El workflow de GitHub Actions (`.github/workflows/ci-cd.yml`) construye la imagen sin pasar `--build-arg`, así que `/version` siempre refleja los valores por defecto que tenga el `Dockerfile` en ese momento (`ARG APP_VERSION=...`), no lo que se cambió en `server.js`. Si se desea que `/version` cambie, hay que editar también esos `ARG` en el `Dockerfile` y subirlos junto con el resto. Lo que sí cambia siempre es el *contenido real* de la página (`/`) y el hash del commit — que es, en el fondo, el identificador de versión que de verdad importa.

**"Se usó `kubectl set image ... app=cicd-practica-sd:v2` y devolvió `ErrImagePull` / `ImagePullBackOff`."**
Ese tag solo existe si la imagen se construyó localmente con `docker build -t cicd-practica-sd:v2 ...` y se cargó con `minikube image load`. Si se está en el flujo real con GitHub Actions, la imagen vive en `ghcr.io`, no en el Docker local — el nombre completo es `ghcr.io/<su-usuario>/cicd-practica-sd:<hash-del-commit>`, nunca un tag corto inventado.

**"Se pasó `--build-arg` pero la imagen no cambió." (en el Plan B local)**
Docker no da error si se le pasa un `--build-arg` que el `Dockerfile` no declaró con `ARG` — simplemente lo ignora. Revise siempre que cada `--build-arg` tenga su `ARG` correspondiente en el `Dockerfile`.

**"Se reconstruyó la imagen pero Minikube sigue usando la anterior." (en el Plan B local)**
Minikube puede cachear una imagen por su nombre de tag y no reemplazarla al volver a ejecutar `minikube image load` con el mismo tag. Si esto ocurre: `minikube ssh -- docker rmi -f <tag>` y volver a cargarla. En el flujo real esto no ocurre nunca, porque cada build de GitHub Actions usa un tag distinto (el hash del commit).

**"Se hizo rollback pero no volvió a la versión esperada."**
Cada cambio a la plantilla del pod (imagen, variables de entorno) crea una revisión nueva en el `Deployment`. `kubectl rollout undo` sin argumentos deshace solo la última. Use `kubectl rollout history deployment/cicd-practica-sd` para ver todas las revisiones antes de decidir a cuál volver, y `--to-revision=N` para ser explícito.

## 12. Preguntas para repasar

1. ¿Por qué el `Dockerfile` ejecuta `npm test` dentro del build, si ya se ejecutó `npm test` a mano en el Paso 2? ¿No es repetir el mismo trabajo dos veces?
2. En el Paso 6, ¿qué habría pasado si `maxUnavailable` fuera igual a `4` (el total de réplicas) en vez de `1`?
3. El pipeline de este ejercicio no tiene ninguna aprobación humana antes de llegar a Kubernetes — apenas pasa CI, es la propia persona quien ejecuta `kubectl set image`. ¿Eso lo convierte en *Continuous Delivery* o en *Continuous Deployment*? ¿Por qué?
4. En el Paso 7, ¿qué ocurrió exactamente con el pod que quedó a medio actualizar (`0/1 Running`, pero nunca `Ready`)? ¿Por qué Kubernetes no lo eliminó inmediatamente?
5. Si en vez de `readinessProbe` el `Deployment` no tuviera ningún probe configurado, ¿el `Service` se habría dado cuenta de que la `v3-roto` estaba fallando? ¿Qué habrían visto los usuarios?
