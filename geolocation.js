let geoMap = null;
let startMarkers = [];
let endMarkers = [];
let boundaryPolygon = null;

const START_ICON = L.icon({
  iconUrl: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"%3E%3Cpath fill="%23ef4444" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/%3E%3C/svg%3E',
  iconSize: [24, 24],
  iconAnchor: [12, 24]
});

const END_ICON = L.icon({
  iconUrl: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"%3E%3Cpath fill="%2322c55e" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/%3E%3C/svg%3E',
  iconSize: [24, 24],
  iconAnchor: [12, 24]
});

function initGeoLocation() {
  const mapContainer = document.getElementById('map');
  if (!mapContainer) return;

  const defaultLatLng = [-2.5489, 118.0169];

  geoMap = L.map('map', {
    center: defaultLatLng,
    zoom: 5,
    minZoom: 5,
    maxZoom: 18
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(geoMap);

  L.control.zoom({ position: 'bottomright' }).addTo(geoMap);
}

function updateGeoLocationMap(filter = 'all') {
  if (!geoMap || !window.kmlResult) return;

  startMarkers.forEach(m => geoMap.removeLayer(m));
  endMarkers.forEach(m => geoMap.removeLayer(m));
  if (boundaryPolygon) geoMap.removeLayer(boundaryPolygon);

  startMarkers = [];
  endMarkers = [];

  const startPoints = window.kmlResult.filter(r => r.SFROM === 'start');
  const endPoints = window.kmlResult.filter(r => r.SFROM === 'end');

  if (filter === 'all' || filter === 'start') {
    startPoints.forEach(p => {
      const marker = L.marker([p.lat, p.lon], { icon: START_ICON }).addTo(geoMap);
      marker.bindPopup(`<div class="geo-popup"><strong>${p.Name || p.EQP}</strong></div>`);
      startMarkers.push(marker);
    });
  }

  if (filter === 'all' || filter === 'end') {
    endPoints.forEach(p => {
      const marker = L.marker([p.lat, p.lon], { icon: END_ICON }).addTo(geoMap);
      marker.bindPopup(`<div class="geo-popup"><strong>${p.Name || p.EQP}</strong></div>`);
      endMarkers.push(marker);
    });
  }

  if (AREA_POLYGONS && AREA_POLYGONS.length > 0) {
    AREA_POLYGONS.forEach(area => {
      if (area.coords && area.coords.length > 0) {
        const latLngCoords = area.coords.map(c => [c[1], c[0]]);
        boundaryPolygon = L.polygon(latLngCoords, {
          color: '#3b82f6',
          fillColor: '#3b82f6',
          fillOpacity: 0.1,
          weight: 2
        }).addTo(geoMap).bindPopup(area.name);
      }
    });
  }

  const group = L.featureGroup([...startMarkers, ...endMarkers, boundaryPolygon].filter(Boolean));
  if (group.getLayers().length > 0) geoMap.fitBounds(group.getBounds().pad(0.2));
}

function setupGeoLocationButtons() {
  const mapContainer = document.querySelector('.leaflet-map');
  if (!mapContainer) return;

  // Jangan tabrakan dengan tombol coordinate table (Start/End) yang ada di UI.
  // Untuk map, pakai selector tombol khusus dengan id.
  if (document.getElementById('btnShowStart') || document.getElementById('btnShowEnd') || document.getElementById('btnShowAll')) {
    return;
  }

  const btnContainer = document.createElement('div');
  btnContainer.className = 'geo-toggle-buttons';
  btnContainer.id = 'geoMapToggleButtons';
  btnContainer.innerHTML = `
    <button id="btnShowStart" class="geo-btn">Loc Start</button>
    <button id="btnShowEnd" class="geo-btn">Loc End</button>
    <button id="btnShowAll" class="geo-btn active">All</button>
  `;

  mapContainer.parentNode.insertBefore(btnContainer, mapContainer.nextSibling);

  document.getElementById('btnShowStart').onclick = () => {
    updateGeoLocationMap('start');
    setActiveButton('btnShowStart');
  };
  document.getElementById('btnShowEnd').onclick = () => {
    updateGeoLocationMap('end');
    setActiveButton('btnShowEnd');
  };
  document.getElementById('btnShowAll').onclick = () => {
    updateGeoLocationMap('all');
    setActiveButton('btnShowAll');
  };
}


function setActiveButton(activeId) {
  document.querySelectorAll('.geo-btn').forEach(btn => btn.classList.remove('active'));
  document.getElementById(activeId)?.classList.add('active');
}

function loadGeoLocation() {
  const geoSection = document.getElementById('geoSection');
  if (!geoSection) return;

  setupGeoLocationButtons();

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.type === 'attributes' && geoSection.classList.contains('active-section')) {
        if (!geoMap) initGeoLocation();
        else geoMap.invalidateSize();
        updateGeoLocationMap('all');
      }
    });
  });

  observer.observe(geoSection, { attributes: true });
}

document.addEventListener('DOMContentLoaded', loadGeoLocation);