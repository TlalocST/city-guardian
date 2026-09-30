const ZONAS_RIESGO = [
    { id: "gam", nombre: "GAM (Gabriel Hernández / La Cienega)", lat: 19.4850, lng: -99.1120, radio: 1000, nivel: "Alto" },
    { id: "tepito", nombre: "Tepito / Morelos", lat: 19.4440, lng: -99.1250, radio: 800, nivel: "Muy Alto" },
    { id: "doctores", nombre: "Doctores / Buenos Aires", lat: 19.4180, lng: -99.1480, radio: 900, nivel: "Medio-Alto" },
    { id: "iztapalapa", nombre: "Iztapalapa Centro", lat: 19.3580, lng: -99.0920, radio: 1500, nivel: "Alto" },
    { id: "ecatepec", nombre: "Ecatepec (Límite GAM)", lat: 19.5350, lng: -99.0250, radio: 1800, nivel: "Alto" }
];

let zonasDibujadas = [];
let zonasVisibles = false;

const STORAGE = {
    users: "rs_usuarios",
    session: "rs_sesion",
    alerts: "rs_alertas"
};

const config = window.APP_CONFIG || {};
const defaultPosition = { lat: 19.4326, lng: -99.1332 };

let activeUser = null;
let currentPosition = null;
let locationWatchId = null;
let mapInstance = null;
let locationMarker = null;
let routeControl = null;

document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("app-version").textContent = config.APP_VERSION || "0.3.0";
    bindEvents();
    restoreSession();
});

function bindEvents() {
    document.querySelectorAll("[data-auth-tab]").forEach(tab => {
        tab.addEventListener("click", () => switchAuthView(tab.dataset.authTab));
    });

    document.getElementById("login-form").addEventListener("submit", iniciarSesion);
    document.getElementById("register-form").addEventListener("submit", registrarUsuario);
    document.getElementById("profile-form").addEventListener("submit", guardarPerfil);
    document.getElementById("panic-button").addEventListener("click", enviarAlertaPanic);
    document.getElementById("zones-button").addEventListener("click", toggleZonasCriticas);
    document.getElementById("recenter-button").addEventListener("click", centrarMapa);
    document.getElementById("profile-button").addEventListener("click", abrirPerfil);
    document.getElementById("close-profile-button").addEventListener("click", cerrarPerfil);
    document.getElementById("logout-button").addEventListener("click", cerrarSesion);
    document.getElementById("profile-modal").addEventListener("click", event => {
        if (event.target.id === "profile-modal") cerrarPerfil();
    });
}

function restoreSession() {
    const savedSession = readJson(STORAGE.session, null);
    if (savedSession) {
        activeUser = savedSession;
        mostrarDashboard();
        return;
    }

    // Compatibility with the first prototype, which stored only the username.
    const oldUser = localStorage.getItem("cg_usuario");
    if (oldUser) {
        activeUser = createUser({
            name: oldUser,
            email: oldUser.includes("@") ? oldUser : "",
            phone: ""
        });
        saveSession();
        mostrarDashboard();
    }
}

function switchAuthView(viewName) {
    const loginActive = viewName === "login";
    document.getElementById("login-form").classList.toggle("is-hidden", !loginActive);
    document.getElementById("register-form").classList.toggle("is-hidden", loginActive);

    document.querySelectorAll("[data-auth-tab]").forEach(tab => {
        const isActive = tab.dataset.authTab === viewName;
        tab.classList.toggle("is-active", isActive);
        tab.setAttribute("aria-selected", String(isActive));
    });
}

async function iniciarSesion(event) {
    event.preventDefault();
    const identifier = document.getElementById("login-identifier").value.trim().toLowerCase();
    const password = document.getElementById("login-password").value;
    const message = document.getElementById("login-message");

    if (!identifier || !password) {
        showMessage(message, "Completa tu correo o teléfono y contraseña.");
        return;
    }

    const user = getUsers().find(item =>
        item.email.toLowerCase() === identifier || normalizePhone(item.phone) === normalizePhone(identifier)
    );

    if (!user) {
        showMessage(message, "No encontramos esa cuenta. Puedes crearla en la pestaña de registro.");
        return;
    }

    if (!user || user.passwordHash !== await hashPassword(password)) {
        showMessage(message, "La contraseña no coincide.");
        return;
    }

    activeUser = user;
    saveSession();
    document.getElementById("login-form").reset();
    showMessage(message, "");
    mostrarDashboard();
}

async function registrarUsuario(event) {
    event.preventDefault();
    const name = document.getElementById("register-name").value.trim();
    const phone = document.getElementById("register-phone").value.trim();
    const email = document.getElementById("register-email").value.trim().toLowerCase();
    const password = document.getElementById("register-password").value;
    const confirmation = document.getElementById("register-password-confirm").value;
    const message = document.getElementById("register-message");

    if (!name || !phone || !email || !password || !confirmation) {
        showMessage(message, "Completa todos los campos para crear tu cuenta.");
        return;
    }

    if (password.length < 6) {
        showMessage(message, "La contraseña debe tener al menos 6 caracteres.");
        return;
    }

    if (password !== confirmation) {
        showMessage(message, "Las contraseñas no coinciden.");
        return;
    }

    const users = getUsers();
    const duplicate = users.some(item => item.email.toLowerCase() === email || normalizePhone(item.phone) === normalizePhone(phone));
    if (duplicate) {
        showMessage(message, "Ya existe una cuenta con ese correo o teléfono.");
        return;
    }

    activeUser = createUser({ name, phone, email, passwordHash: await hashPassword(password) });
    saveUsers([...users, activeUser]);
    saveSession();
    document.getElementById("register-form").reset();
    showMessage(message, "");
    mostrarDashboard();
}

function mostrarDashboard() {
    document.getElementById("auth-view").classList.add("is-hidden");
    document.getElementById("dashboard-view").classList.remove("is-hidden");
    document.getElementById("dashboard-greeting").textContent = `Hola, ${activeUser.name || "usuario"}`;
    document.getElementById("profile-initials").textContent = getInitials(activeUser.name);
    document.getElementById("call-button").href = `tel:${config.EMERGENCY_PHONE || "911"}`;
    document.getElementById("call-label").textContent = config.EMERGENCY_PHONE || "911";
    fillProfileForm();
    startLocationTracking();
    loadLeafletMap();
}

function cerrarSesion() {
    stopLocationTracking();
    activeUser = null;
    localStorage.removeItem(STORAGE.session);
    localStorage.removeItem("cg_usuario");
    cerrarPerfil();
    document.getElementById("dashboard-view").classList.add("is-hidden");
    document.getElementById("auth-view").classList.remove("is-hidden");
    switchAuthView("login");
}

function startLocationTracking() {
    if (!navigator.geolocation) {
        setLocationStatus("Este dispositivo no permite obtener ubicación.", false);
        return;
    }

    setLocationStatus("Solicitando ubicación…", false);
    locationWatchId = navigator.geolocation.watchPosition(
        updateLocation,
        handleLocationError,
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
}

function stopLocationTracking() {
    if (locationWatchId !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(locationWatchId);
    }
    locationWatchId = null;
}

function updateLocation(position) {
    currentPosition = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: Math.round(position.coords.accuracy),
        speed: position.coords.speed || 0,
        capturedAt: new Date().toISOString()
    };

    setLocationStatus("Ubicación en vivo", true);
    document.getElementById("coordinates").textContent = `${currentPosition.lat.toFixed(5)}, ${currentPosition.lng.toFixed(5)} · ±${currentPosition.accuracy} m`;
    updateMapPosition();
    actualizarZonasCercanas(currentPosition.lat, currentPosition.lng);
}

function handleLocationError(error) {
    const messages = {
        1: "Permiso de ubicación denegado.",
        2: "No se pudo determinar tu ubicación.",
        3: "La ubicación tardó demasiado en responder."
    };
    setLocationStatus(messages[error.code] || "Ubicación no disponible.", false);
}

function setLocationStatus(text, live) {
    const status = document.getElementById("location-status");
    status.querySelector("span:last-child").textContent = text;
    status.querySelector(".status-dot").classList.toggle("is-live", live);
}

function loadLeafletMap() {
    if (!window.L || mapInstance) return;

    const initialPosition = currentPosition || defaultPosition;
    mapInstance = L.map("map").setView([initialPosition.lat, initialPosition.lng], currentPosition ? 16 : 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
        maxZoom: 19
    }).addTo(mapInstance);

    mapInstance.on("click", event => {
        if (!currentPosition) {
            showDashboardMessage("Espera a que se detecte tu ubicaci�n antes de elegir un destino.");
            return;
        }
        if (routeControl) mapInstance.removeControl(routeControl);
        routeControl = L.Routing.control({
            waypoints: [
                L.latLng(currentPosition.lat, currentPosition.lng),
                event.latlng
            ],
            routeWhileDragging: false,
            show: false,
            addWaypoints: false,
            createMarker: (index, waypoint, count) => L.marker(waypoint.latLng).bindPopup(index === 0 ? "Punto de partida" : "Destino")
        }).addTo(mapInstance);
    });

    mapInstance.on("locationfound", event => {
        currentPosition = {
            lat: event.latlng.lat,
            lng: event.latlng.lng,
            accuracy: Math.round(event.accuracy),
            speed: 0,
            capturedAt: new Date().toISOString()
        };
        if (!locationMarker) locationMarker = L.marker(event.latlng, { title: "Punto de partida" }).addTo(mapInstance).bindPopup("Punto de partida");
        else locationMarker.setLatLng(event.latlng);
        setLocationStatus("Ubicaci�n en vivo", true);
        document.getElementById("coordinates").textContent = `${currentPosition.lat.toFixed(5)}, ${currentPosition.lng.toFixed(5)} � �${currentPosition.accuracy} m`;
        actualizarZonasCercanas(currentPosition.lat, currentPosition.lng);
    });
    mapInstance.on("locationerror", event => {
        setLocationStatus(event.message || "Ubicaci�n no disponible.", false);
    });
    mapInstance.locate({ setView: true, maxZoom: 16, enableHighAccuracy: true });
    if (currentPosition) updateMapPosition();
}

function updateMapPosition() {
    if (!currentPosition || !mapInstance) return;
    const position = [currentPosition.lat, currentPosition.lng];
    if (!locationMarker) locationMarker = L.marker(position, { title: "Punto de partida" }).addTo(mapInstance).bindPopup("Punto de partida");
    else locationMarker.setLatLng(position);
    mapInstance.panTo(position);
}
function centrarMapa() {
    if (currentPosition && mapInstance) {
        mapInstance.panTo({ lat: currentPosition.lat, lng: currentPosition.lng });
        mapInstance.setZoom(17);
        return;
    }
    showDashboardMessage("Aún estamos esperando la ubicación del dispositivo.");
}

async function enviarAlertaPanic() {
    const position = currentPosition || await getOneLocation();
    const alert = {
        id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
        userId: activeUser?.id || null,
        type: "BOTON_PANICO",
        severity: "ALTA",
        latitude: position?.lat || null,
        longitude: position?.lng || null,
        telemetry: position || {},
        status: "NO_ATENDIDA",
        createdAt: new Date().toISOString()
    };

    const alerts = readJson(STORAGE.alerts, []);
    localStorage.setItem(STORAGE.alerts, JSON.stringify([alert, ...alerts]));
    navigator.vibrate?.([180, 80, 180]);
    showDashboardMessage(position ? "Alerta guardada con tu ubicación. Conecta el backend para enviarla a la central." : "Alerta guardada. No se obtuvo la ubicación actual.");

    if (config.API_BASE_URL) {
        await sendToApi("/alertas", alert);
    }
}

function getOneLocation() {
    return new Promise(resolve => {
        if (!navigator.geolocation) return resolve(null);
        navigator.geolocation.getCurrentPosition(
            position => resolve({ lat: position.coords.latitude, lng: position.coords.longitude, accuracy: Math.round(position.coords.accuracy) }),
            () => resolve(null),
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 }
        );
    });
}

function abrirPerfil() {
    fillProfileForm();
    document.getElementById("profile-modal").classList.remove("is-hidden");
    document.getElementById("profile-name").focus();
}

function cerrarPerfil() {
    document.getElementById("profile-modal").classList.add("is-hidden");
}

function fillProfileForm() {
    if (!activeUser) return;
    document.getElementById("profile-name").value = activeUser.name || "";
    document.getElementById("profile-phone").value = activeUser.phone || "";
    document.getElementById("profile-email").value = activeUser.email || "";
    document.getElementById("profile-device").value = activeUser.deviceModel || "";
}

async function guardarPerfil(event) {
    event.preventDefault();
    const updated = {
        ...activeUser,
        name: document.getElementById("profile-name").value.trim(),
        phone: document.getElementById("profile-phone").value.trim(),
        email: document.getElementById("profile-email").value.trim().toLowerCase(),
        deviceModel: document.getElementById("profile-device").value.trim()
    };

    if (!updated.name || !updated.phone || !updated.email) {
        showMessage(document.getElementById("profile-message"), "Nombre, teléfono y correo son obligatorios.");
        return;
    }

    const users = getUsers().filter(user => user.id !== activeUser.id);
    saveUsers([...users, updated]);
    activeUser = updated;
    saveSession();
    document.getElementById("dashboard-greeting").textContent = `Hola, ${activeUser.name}`;
    document.getElementById("profile-initials").textContent = getInitials(activeUser.name);
    showMessage(document.getElementById("profile-message"), "Cambios guardados.");

    if (config.API_BASE_URL && updated.id) {
        await sendToApi(`/usuarios/${encodeURIComponent(updated.id)}`, updated, "PUT");
    }
}

async function sendToApi(path, payload, method = "POST") {
    try {
        await fetch(`${config.API_BASE_URL.replace(/\/$/, "")}${path}`, {
            method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
    } catch (error) {
        console.error("La API no está disponible:", error);
    }
}

function createUser(data) {
    return {
        id: data.id || (crypto.randomUUID ? crypto.randomUUID() : `local-${Date.now()}`),
        name: data.name || "Usuario",
        phone: data.phone || "",
        email: data.email || "",
        passwordHash: data.passwordHash || "",
        deviceModel: data.deviceModel || navigator.userAgent.slice(0, 48),
        appVersion: config.APP_VERSION || "0.3.0",
        createdAt: data.createdAt || new Date().toISOString()
    };
}

async function hashPassword(password) {
    const data = new TextEncoder().encode(password);
    const hash = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

function getUsers() {
    return readJson(STORAGE.users, []);
}

function saveUsers(users) {
    localStorage.setItem(STORAGE.users, JSON.stringify(users));
}

function saveSession() {
    localStorage.setItem(STORAGE.session, JSON.stringify(activeUser));
}

function readJson(key, fallback) {
    try {
        return JSON.parse(localStorage.getItem(key)) || fallback;
    } catch {
        return fallback;
    }
}

function normalizePhone(phone) {
    return String(phone || "").replace(/\D/g, "");
}

function getInitials(name) {
    return String(name || "RS")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map(part => part[0].toUpperCase())
        .join("") || "RS";
}

function showMessage(element, message) {
    element.textContent = message;
}

function showDashboardMessage(message) {
    const element = document.getElementById("dashboard-message");
    element.textContent = message;
    window.clearTimeout(showDashboardMessage.timeout);
    showDashboardMessage.timeout = window.setTimeout(() => {
        element.textContent = "";
    }, 7000);
}

function toggleZonasCriticas() {
    zonasVisibles = !zonasVisibles;
    const button = document.getElementById("zones-button");
    const label = document.getElementById("zones-label");

    if (zonasVisibles) {
        button.classList.add("is-active");
        label.textContent = "Ocultar áreas de riesgo";
        actualizarZonasCercanas();
        return;
    }

    button.classList.remove("is-active");
    label.textContent = "Mostrar áreas de riesgo";
    limpiarZonas();
    document.getElementById("dashboard-message").textContent = "";
}

function limpiarZonas() {
    zonasDibujadas.forEach(circle => mapInstance.removeLayer(circle));
    zonasDibujadas = [];
}

// --- FUNCIONES DE DETECCIÓN DE ZONAS CERCANAS ---

function calcularDistanciaKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function actualizarZonasCercanas(userLat = currentPosition?.lat, userLng = currentPosition?.lng) {
    if (!mapInstance || !zonasVisibles) return;
    if (!Number.isFinite(userLat) || !Number.isFinite(userLng)) return;

    // Limpiar círculos dibujados anteriormente
    limpiarZonas();

    let zonaCercanaDetectada = null;

    ZONAS_RIESGO.forEach(zona => {
        const distanciaKm = calcularDistanciaKm(userLat, userLng, zona.lat, zona.lng);

        // Dibuja en el mapa si la zona está a menos de 10 km del usuario
        if (distanciaKm <= 10.0) {
            const circle = L.circle([zona.lat, zona.lng], {
                color: "#FF2D55",
                weight: 2,
                fillColor: "#FF2D55",
                fillOpacity: 0.35,
                radius: zona.radio
            }).addTo(mapInstance);

            zonasDibujadas.push(circle);

            // Si el usuario está físicamente dentro del radio de la zona
            if (distanciaKm * 1000 <= zona.radio) {
                zonaCercanaDetectada = zona;
            }
        }
    });

    if (zonaCercanaDetectada) {
        showDashboardMessage(`⚠️ ATENCIÓN: Te encuentras dentro de una zona de riesgo: ${zonaCercanaDetectada.nombre}`);
    }
}
