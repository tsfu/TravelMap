// configure Cesium ion
function resolveCesiumToken() {
  if (window.CESIUM_ION_TOKEN) {
    return window.CESIUM_ION_TOKEN;
  }
  try {
    const token = localStorage.getItem("cesiumIonToken");
    if (token) {
      return token;
    }
  } catch (err) {
    console.warn("WARN: Cannot read Cesium token from localStorage.");
  }
  // Fallback token for backwards compatibility. Use restricted token in production.
  return "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI5NmYzOGI3YS1hNTJmLTQxMDgtODk2OC1jNDAzZWJkZTA2NTYiLCJpZCI6MjQyOTgwLCJpYXQiOjE3MjY4NDU5MDd9.P4ba4zMM5yLj4ppDe-YrpX0IOcR8AkwvKV5tjCrbY5s";
}
Cesium.Ion.defaultAccessToken = resolveCesiumToken();

const viewer = new Cesium.Viewer("cesiumContainer", {
  animation: false, // Removes the animation widget
  timeline: false, // Removes the timeline widget
});
// remove invalid imagery/terrain providers from base-layer picker
viewer.baseLayerPicker.viewModel.terrainProviderViewModels = [];
let providers = viewer.baseLayerPicker.viewModel.imageryProviderViewModels;
let newProviders = [];
for (let i = 0; i < providers.length; i++) {
  const provider = providers[i];
  if (!(provider.name == "Blue Marble" || provider._category != "Cesium ion")) {
    newProviders.push(provider);
  }
}
viewer.baseLayerPicker.viewModel.imageryProviderViewModels = newProviders;

const tripStorageKey = "tripsStorage";
const tripDbName = "airlog";
const tripDbStoreName = "trips";
const tripDbVersion = 1;

// Flight-lookup proxy (Cloudflare Worker). Fetches trip details from a flight number.
const FLIGHT_LOOKUP_URL = "https://airlog-flight.fts1109.workers.dev/";
// AeroDataBox free tier only serves flights within +/- 365 days of today.
const FLIGHT_LOOKUP_MAX_DAYS = 365;

// hold user's trips
let trips = [];
const tripIndexMap = new Map();
let tripStorageMode = "indexeddb";
let tripDbPromise = null;

function indexTrip(trip) {
  if (trip && trip.id) {
    tripIndexMap.set(trip.id, trip);
  }
}

function removeTripFromIndex(tripId) {
  tripIndexMap.delete(tripId);
}

function getTripById(tripId) {
  return tripIndexMap.get(tripId) || null;
}

function getStoredTripsSafeLocal() {
  try {
    const raw = localStorage.getItem(tripStorageKey);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    console.warn("WARN: tripsStorage is not an array. Clearing invalid value.");
  } catch (err) {
    console.error("ERROR: tripsStorage cannot be parsed. Clearing invalid value.", err);
  }
  try {
    localStorage.removeItem(tripStorageKey);
  } catch (err) {
    console.warn("WARN: Cannot clear invalid tripsStorage.");
  }
  return [];
}

function openTripsDatabase() {
  if (tripDbPromise) {
    return tripDbPromise;
  }

  tripDbPromise = new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("IndexedDB API is unavailable in this browser."));
      return;
    }
    const request = window.indexedDB.open(tripDbName, tripDbVersion);

    request.onupgradeneeded = function (event) {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(tripDbStoreName)) {
        db.createObjectStore(tripDbStoreName, { keyPath: "id" });
      }
    };

    request.onsuccess = function () {
      resolve(request.result);
    };

    request.onerror = function () {
      tripDbPromise = null;
      reject(request.error || new Error("Failed to open IndexedDB."));
    };

    request.onblocked = function () {
      tripDbPromise = null;
      console.warn(
        "WARN: IndexedDB upgrade blocked by another open tab."
      );
      reject(new Error("IndexedDB is blocked by another open tab."));
    };
  });

  return tripDbPromise;
}

async function initTripStorage() {
  if (!window.indexedDB) {
    tripStorageMode = "localstorage";
    console.warn("WARN: IndexedDB unavailable, falling back to localStorage.");
    return;
  }
  try {
    await openTripsDatabase();
    tripStorageMode = "indexeddb";
    console.log("INFO: Trip storage backend: IndexedDB.");
  } catch (err) {
    tripStorageMode = "localstorage";
    console.warn(
      "WARN: IndexedDB init failed, falling back to localStorage.",
      err
    );
  }
}

async function loadTripsFromStorage() {
  if (tripStorageMode !== "indexeddb") {
    return getStoredTripsSafeLocal();
  }
  try {
    const db = await openTripsDatabase();
    const result = await new Promise((resolve, reject) => {
      const tx = db.transaction(tripDbStoreName, "readonly");
      const store = tx.objectStore(tripDbStoreName);
      const request = store.getAll();
      request.onsuccess = function () {
        resolve(Array.isArray(request.result) ? request.result : []);
      };
      request.onerror = function () {
        reject(request.error || new Error("Failed to read trips from IndexedDB."));
      };
    });
    return result;
  } catch (err) {
    tripStorageMode = "localstorage";
    console.warn(
      "WARN: IndexedDB read failed, falling back to localStorage.",
      err
    );
    return getStoredTripsSafeLocal();
  }
}

async function saveTripsToStorage(tripsToSave) {
  if (!Array.isArray(tripsToSave)) {
    throw new Error("Trips payload must be an array.");
  }
  if (tripStorageMode !== "indexeddb") {
    localStorage.setItem(tripStorageKey, JSON.stringify(tripsToSave));
    return;
  }
  try {
    const db = await openTripsDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(tripDbStoreName, "readwrite");
      const store = tx.objectStore(tripDbStoreName);
      const clearRequest = store.clear();
      clearRequest.onerror = function () {
        reject(clearRequest.error || new Error("Failed to clear IndexedDB trips."));
      };
      clearRequest.onsuccess = function () {
        tripsToSave.forEach((trip) => {
          store.put(trip);
        });
      };
      tx.oncomplete = function () {
        resolve();
      };
      tx.onerror = function () {
        reject(tx.error || new Error("Failed to save trips to IndexedDB."));
      };
      tx.onabort = function () {
        reject(tx.error || new Error("IndexedDB transaction aborted."));
      };
    });
  } catch (err) {
    tripStorageMode = "localstorage";
    console.warn(
      "WARN: IndexedDB write failed, falling back to localStorage.",
      err
    );
    localStorage.setItem(tripStorageKey, JSON.stringify(tripsToSave));
  }
}

async function upsertTripInStorage(trip) {
  if (tripStorageMode !== "indexeddb") {
    await saveTripsToStorage(trips);
    return;
  }
  try {
    const db = await openTripsDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(tripDbStoreName, "readwrite");
      tx.objectStore(tripDbStoreName).put(trip);
      tx.oncomplete = function () {
        resolve();
      };
      tx.onerror = function () {
        reject(tx.error || new Error("Failed to upsert trip."));
      };
      tx.onabort = function () {
        reject(tx.error || new Error("IndexedDB transaction aborted."));
      };
    });
  } catch (err) {
    tripStorageMode = "localstorage";
    console.warn(
      "WARN: IndexedDB upsert failed, falling back to localStorage.",
      err
    );
    await saveTripsToStorage(trips);
  }
}

async function deleteTripFromStorage(tripId) {
  if (tripStorageMode !== "indexeddb") {
    await saveTripsToStorage(trips);
    return;
  }
  try {
    const db = await openTripsDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(tripDbStoreName, "readwrite");
      tx.objectStore(tripDbStoreName).delete(tripId);
      tx.oncomplete = function () {
        resolve();
      };
      tx.onerror = function () {
        reject(tx.error || new Error("Failed to delete trip."));
      };
      tx.onabort = function () {
        reject(tx.error || new Error("IndexedDB transaction aborted."));
      };
    });
  } catch (err) {
    tripStorageMode = "localstorage";
    console.warn(
      "WARN: IndexedDB delete failed, falling back to localStorage.",
      err
    );
    await saveTripsToStorage(trips);
  }
}

// switch between tabs
function openTab(event, tabName) {
  // Get all elements with class="tab-content" and hide them
  const tabContents = $(".tab-content");
  tabContents.removeClass("active");

  // Show the current tab and add "active" class to the clicked tab
  $("#" + tabName).addClass("active");

  // Remove active state from all links
  const tabLinks = $(".tab-link");
  tabLinks.removeClass("active");

  // Add active state to the clicked tab link
  event.currentTarget.classList.add("active");

  if (tabName === "radar-view" && typeof window.initRadarTab === "function") {
    window.initRadarTab();
  }
}

// load airport info into map
async function init() {
  await initTripStorage();
  // load data & build index
  await getAirportDataAsync();
  await getAirlineDataAsync();
  await getAircraftDataAsync();

  // load previously stored trips
  await populateLogFromStorage();
  // Set display for demo button and table header
  toggleTableDisplay();
  toggleDemoButton();

  // for stats calc
  loadStats();
  // for input autocomplete
  populateInputOptions();

  // enable test in console for helper functions
  // Test();
}

// populate table in "Log View" with stored trips
async function populateLogFromStorage() {
  const tripsStorage = await loadTripsFromStorage();
  if (tripsStorage == null || tripsStorage.length == 0) return;

  let loaded = 0;
  let skipped = 0;
  for (const trip of tripsStorage) {
    try {
      await addTrip(
        trip.id,
        trip.departureCity,
        trip.departureIATA,
        trip.arrivalCity,
        trip.arrivalIATA,
        trip.takeOffTime,
        trip.landingTime,
        trip.duration,
        trip.distance,
        trip.flightNumber,
        trip.airline,
        trip.aircraft,
        trip.tailNumber,
        trip.seatClass,
        trip.seatNumber,
        { skipPersist: true, skipRender: true }
      );
      loaded += 1;
    } catch (error) {
      skipped += 1;
      console.warn("WARN: Skipping invalid stored trip during load.", error);
    }
  }
  if (loaded > 0) {
    await saveTripsToStorage(trips);
    refreshGlobeRoutes(viewer);
  }
  if (skipped > 0) {
    console.warn("WARN: Skipped " + skipped + " invalid stored trip(s).");
  }
  console.log("INFO: Trips data successfully retrieved.");
}

// console log testing basic functions
async function Test() {
  // test distance
  const test = getDistance("BOS", "HKG");
  console.log("TEST BOS-HKG distance: " + test);
  const test2 = getDistance("MIG", "XIY");
  console.log("TEST MIG-XIY distance: " + test2);
  // test duration
  const dur1 = await getDuration(
    "2024-09-24T19:40:00",
    "2024-09-25T06:50:00",
    "BOS",
    "LHR"
  );
  console.log("Test duration BOS-LHR: " + dur1);
  const dur2 = await getDuration(
    "2024-07-21T11:34:00",
    "2024-07-21T15:17:00",
    "JFK",
    "LAX"
  );
  console.log("Test duration JFK-LAX: " + dur2);
}

// trip input modal
const modal = $("#addTripModal");
const tripForm = $("#tripForm");

function resetTripFormState() {
  tripForm[0].reset();
  $("#submitTripButton").removeAttr("hidden");
  $("#updateTripButton").attr("hidden", "hidden");
  sessionStorage.removeItem("editTripID");
  sessionStorage.removeItem("editRowIndex");
  // clear autofill helper UI (inputs are reset by form.reset above)
  $("#autofillButton").prop("disabled", false);
  $("#legPicker").attr("hidden", "hidden").empty();
  if (typeof setAutofillStatus === "function") setAutofillStatus("");
}

function isEditingTrip() {
  return !$("#updateTripButton").attr("hidden");
}

// close modal
$(".modal-close").on("click", function () {
  resetTripFormState();
  modal.hide();
});

// When the user clicks anywhere outside of the modal close it
window.onclick = function (event) {
  if (event.target == modal[0]) {
    resetTripFormState();
    modal.hide();
  }
};

// demo button
$("#demoButton").on("click", demo);

// "add trip" button
$("#addTripButton").on("click", function () {
  // clear form and reset button mode in case an edit was cancelled halfway
  resetTripFormState();
  modal.show();
});

// "import from file" button
$("#importButton").on("click", function () {
  $("#json-input").trigger("click");
});

// "import from myFR24" button
$("#importFRButton").on("click", function () {
  $("#csv-input").trigger("click");
});

// "export trips" button
$("#exportButton").on("click", exportToJSON);

// handle form submission when editing a trip
$("#updateTripButton").on("click", function () {
  tripForm.trigger("submit");
});

// auto-populate city based on IATA input
$("#departureIATA").keyup(function () {
  const iata = $("#departureIATA").val().substring(0, 3).toUpperCase();
  if (iata.length > 2 && isValidAirport(iata)) {
    $("#departureCity").val(airportDataMap.get(iata).city);
  }
});
$("#arrivalIATA").keyup(function () {
  const iata = $("#arrivalIATA").val().substring(0, 3).toUpperCase();
  if (iata.length > 2 && isValidAirport(iata)) {
    $("#arrivalCity").val(airportDataMap.get(iata).city);
  }
});

// ---- Autofill trip details from a flight number + date (via Worker proxy) ----

// Show/clear a status message under the autofill box (error tone by default).
function setAutofillStatus(msg, isInfo = false) {
  const el = $("#autofillStatus");
  if (!msg) {
    el.attr("hidden", "hidden").removeClass("info").text("");
    return;
  }
  el.text(msg).toggleClass("info", isInfo).removeAttr("hidden");
}

// Enable/disable the Autofill button based on the date being within +/-365 days.
function validateLookupDate() {
  const dateStr = $("#lookupDate").val();
  const btn = $("#autofillButton");
  if (!dateStr) {
    btn.prop("disabled", false); // no date yet: click handler will prompt
    return;
  }
  const diff = daysFromToday(dateStr);
  if (isNaN(diff) || Math.abs(diff) > FLIGHT_LOOKUP_MAX_DAYS) {
    btn.prop("disabled", true);
    setAutofillStatus(
      "Flight info can only be fetched within one year of today. Please enter these details manually."
    );
  } else {
    btn.prop("disabled", false);
    setAutofillStatus("");
  }
}
$("#lookupDate").on("input change", validateLookupDate);

// Fill the trip form fields from one normalized leg. All fields stay editable.
function populateFormFromLeg(leg) {
  const flightNo = normalizeFlightNumber($("#lookupFlightNumber").val());
  $("#departureIATA").val(leg.departureIATA || "");
  $("#departureCity").val(leg.departureCity || "");
  $("#arrivalIATA").val(leg.arrivalIATA || "");
  $("#arrivalCity").val(leg.arrivalCity || "");
  $("#takeOffTime").val(leg.takeOffTime || "");
  $("#landingTime").val(leg.landingTime || "");
  $("#flightNumber").val(flightNo);
  $("#tailNumber").val(leg.tailNumber || "");

  // Airline: form validates by ICAO -> resolve to the datalist "Name (IATA/ICAO)" string.
  $("#airline").val(resolveAirlineValue(leg, flightNo));

  // Aircraft: API gives a model name; map to our datalist option when possible.
  const acOption = findAircraftOptionByModel(leg.aircraft);
  $("#aircraft").val(acOption || leg.aircraft || "");

  const cargoNote = leg.isCargo ? " (cargo flight)" : "";
  setAutofillStatus(
    "Filled from " + flightNo + cargoNote + ". Review and edit before submitting.",
    true
  );
}

// Render a chooser when a flight number returns multiple legs.
function showLegPicker(legs) {
  const picker = $("#legPicker");
  picker.empty();
  legs.forEach((leg) => {
    const label =
      (leg.departureIATA || "???") + " \u2192 " + (leg.arrivalIATA || "???") +
      "  " + (leg.takeOffTime ? leg.takeOffTime.replace("T", " ") : "");
    const btn = $("<button type='button'></button>").text(label);
    btn.on("click", function () {
      populateFormFromLeg(leg);
      picker.attr("hidden", "hidden").empty();
    });
    picker.append(btn);
  });
  picker.removeAttr("hidden");
  setAutofillStatus("Multiple flights found \u2014 pick the correct leg:", true);
}

// Autofill button click: validate, call the proxy, populate.
$("#autofillButton").on("click", async function () {
  const flightNo = normalizeFlightNumber($("#lookupFlightNumber").val());
  const date = $("#lookupDate").val();
  $("#legPicker").attr("hidden", "hidden").empty();

  if (!flightNo) {
    setAutofillStatus("Enter a flight number first (e.g. UA123).");
    return;
  }
  if (!date) {
    setAutofillStatus("Pick the flight date first.");
    return;
  }
  const diff = daysFromToday(date);
  if (isNaN(diff) || Math.abs(diff) > FLIGHT_LOOKUP_MAX_DAYS) {
    setAutofillStatus("Flight info can only be fetched within one year of today.");
    return;
  }

  const btn = $(this);
  const original = btn.text();
  btn.prop("disabled", true).text("Looking up\u2026");
  setAutofillStatus("Fetching flight details\u2026", true);
  try {
    const url = FLIGHT_LOOKUP_URL + "?no=" + encodeURIComponent(flightNo) +
      "&date=" + encodeURIComponent(date);
    const res = await fetch(url);
    if (!res.ok) throw new Error("service returned " + res.status);
    const data = await res.json();
    const legs = (data && data.legs) || [];
    if (legs.length === 0) {
      setAutofillStatus(
        "No flight found for " + flightNo + " on " + date + ". Please enter details manually."
      );
    } else if (legs.length === 1) {
      populateFormFromLeg(legs[0]);
    } else {
      showLegPicker(legs);
    }
  } catch (err) {
    console.error("ERROR: flight lookup failed.", err);
    setAutofillStatus("Lookup failed (" + err.message + "). Please enter details manually.");
  } finally {
    btn.text(original);
    validateLookupDate(); // restore disabled state based on current date
  }
});

// handle form submission for both add and edit trip
tripForm.on("submit", async function (event) {
  event.preventDefault(); // Prevent the form from submitting the traditional way
  if (isEditingTrip()) {
    try {
      await updateTrip();
    } catch (err) {
      console.error("ERROR: Cannot update trip.", err);
      alert("ERROR: Cannot update trip: " + err.message);
    }
    return;
  }
  // Add one trip/row from HTML Form
  try {
    await addTrip(
      "", // no ID from input, will auto-generate
      $("#departureCity").val(),
      $("#departureIATA").val().substring(0, 3),
      $("#arrivalCity").val(),
      $("#arrivalIATA").val().substring(0, 3),
      $("#takeOffTime").val(),
      $("#landingTime").val(),
      "", // no duration from input, will calc
      "", // no distance from input, will calc
      $("#flightNumber").val(),
      $("#airline").val(), // will process later
      $("#aircraft").val(), // will process later
      $("#tailNumber").val(),
      $("#seatClass").val(),
      $("#seatNumber").val()
    );
  } catch (err) {
    alert("ERROR: Cannot add trip: " + err.message);
    return;
  }
  // Reset the form and hide it after submission
  resetTripFormState();
  loadStats();
  toggleDemoButton();
  modal.hide();
});

// handle csv import for myFR24
$("#csv-input").on("change", function (event) {
  const fileInput = this;
  const file = event.target.files[0];
  if (file) {
    const reader = new FileReader();
    reader.onload = async function (e) {
      try {
        await importFR24(e);
      } finally {
        fileInput.value = "";
      }
    };
    reader.onerror = function () {
      fileInput.value = "";
    };
    reader.readAsText(file);
  }
});

// handle json import
$("#json-input").on("change", function (event) {
  const fileInput = this;
  const file = event.target.files[0];
  if (file) {
    const reader = new FileReader();
    reader.onload = async function (e) {
      const jsonContent = e.target.result;
      try {
        const importedTrips = JSON.parse(jsonContent);
        if (!Array.isArray(importedTrips)) {
          alert(
            "Invalid JSON format. Please upload an Array of valid trips.\nSee README for more info."
          );
          return;
        }
        const existingKeys = buildExistingTripDuplicateKeySet();
        const batchKeys = new Set();
        const issueSamples = [];
        const candidates = [];
        let invalidRows = 0;
        let duplicateRows = 0;

        for (let i = 0; i < importedTrips.length; i++) {
          const rowNumber = i + 1;
          const trip = importedTrips[i];
          if (!trip || typeof trip !== "object") {
            invalidRows += 1;
            pushImportIssueSample(
              issueSamples,
              "Row " + rowNumber + ": entry is not a valid object."
            );
            continue;
          }
          const departureIATA = normalizeIATACode(trip.departureIATA);
          const arrivalIATA = normalizeIATACode(trip.arrivalIATA);
          const takeOffTime = (trip.takeOffTime || "").toString().trim();
          const landingTime = (trip.landingTime || "").toString().trim();
          const missing = [];
          if (!departureIATA) missing.push("departureIATA");
          if (!arrivalIATA) missing.push("arrivalIATA");
          if (!takeOffTime) missing.push("takeOffTime");
          if (!landingTime) missing.push("landingTime");
          if (missing.length > 0) {
            invalidRows += 1;
            pushImportIssueSample(
              issueSamples,
              "Row " + rowNumber + ": missing " + missing.join(", ") + "."
            );
            continue;
          }
          if (!isValidAirport(departureIATA) || !isValidAirport(arrivalIATA)) {
            invalidRows += 1;
            pushImportIssueSample(
              issueSamples,
              "Row " + rowNumber + ": invalid airport IATA code."
            );
            continue;
          }

          const flightNumber = normalizeFlightNumber(trip.flightNumber);
          if (
            !isValidDateTimeInput(takeOffTime) ||
            !isValidDateTimeInput(landingTime)
          ) {
            invalidRows += 1;
            pushImportIssueSample(
              issueSamples,
              "Row " + rowNumber + ": invalid takeoff/landing datetime."
            );
            continue;
          }

          const duplicateKey = getTripDuplicateKeyFromValues(
            departureIATA,
            arrivalIATA,
            takeOffTime,
            flightNumber,
            landingTime
          );
          if (existingKeys.has(duplicateKey) || batchKeys.has(duplicateKey)) {
            duplicateRows += 1;
            pushImportIssueSample(
              issueSamples,
              "Row " +
                rowNumber +
                ": duplicate flight (" +
                departureIATA +
                "-" +
                arrivalIATA +
                " " +
                takeOffTime.substring(0, 10) +
                ")."
            );
            continue;
          }

          batchKeys.add(duplicateKey);
          candidates.push({
            id: trip.id,
            departureCity:
              (trip.departureCity || "").toString().trim() ||
              airportDataMap.get(departureIATA).city ||
              "",
            departureIATA: departureIATA,
            arrivalCity:
              (trip.arrivalCity || "").toString().trim() ||
              airportDataMap.get(arrivalIATA).city ||
              "",
            arrivalIATA: arrivalIATA,
            takeOffTime: takeOffTime,
            landingTime: landingTime,
            duration: trip.duration,
            distance: trip.distance,
            flightNumber: flightNumber,
            airline: trip.airline,
            aircraft: trip.aircraft,
            tailNumber: trip.tailNumber,
            seatClass: trip.seatClass,
            seatNumber: trip.seatNumber,
          });
        }

        const previewMessage = buildImportSummaryMessage(
          "JSON",
          importedTrips.length,
          candidates.length,
          invalidRows,
          duplicateRows,
          issueSamples
        );
        if (candidates.length < 1) {
          alert(previewMessage);
          return;
        }
        const shouldImport = window.confirm(
          previewMessage + "\n\nContinue importing these trips?"
        );
        if (!shouldImport) {
          return;
        }

        const commitErrors = [];
        for (const trip of candidates) {
          try {
            await addTrip(
              trip.id,
              trip.departureCity,
              trip.departureIATA,
              trip.arrivalCity,
              trip.arrivalIATA,
              trip.takeOffTime,
              trip.landingTime,
              trip.duration,
              trip.distance,
              trip.flightNumber,
              trip.airline,
              trip.aircraft,
              trip.tailNumber,
              trip.seatClass,
              trip.seatNumber,
              { skipPersist: true, skipRender: true }
            );
          } catch (error) {
            pushImportIssueSample(commitErrors, error.message);
          }
        }
        if (commitErrors.length > 0) {
          alert(
            "Some JSON rows failed while importing:\n" +
              commitErrors.map((x) => "- " + x).join("\n")
          );
        }
        await saveTripsToStorage(trips);
        refreshGlobeRoutes(viewer);
        loadStats();
        toggleDemoButton();
      } catch (err) {
        alert("Error importing JSON file: " + err.message);
      } finally {
        fileInput.value = "";
      }
    };
    reader.onerror = function () {
      fileInput.value = "";
    };
    reader.readAsText(file);
  }
});

// Add a single row in table UI, also save a trip data object
async function addTrip(
  id,
  departureCity,
  departureIATA,
  arrivalCity,
  arrivalIATA,
  takeOffTime,
  landingTime,
  duration,
  distance,
  flightNumber,
  airline,
  aircraft,
  tailNumber,
  seatClass,
  seatNumber,
  options = {}
) {
  const { skipPersist = false, skipRender = false } = options;
  // Get the input values from the form
  let trip = {};
  trip.departureIATA = normalizeIATACode(departureIATA);
  trip.arrivalIATA = normalizeIATACode(arrivalIATA);

  // Input has to be correct IATAs to cintune
  const validIATA =
    isValidAirport(trip.departureIATA) && isValidAirport(trip.arrivalIATA);
  if (!validIATA) {
    throw new Error(
      "airport not found. \nPlease check your airport IATA codes or use suggested values."
    );
  }

  trip.departureCity = (departureCity || "").toString().trim();
  trip.arrivalCity = (arrivalCity || "").toString().trim();
  trip.takeOffTime = (takeOffTime || "").toString();
  trip.landingTime = (landingTime || "").toString();
  trip.duration = duration;
  trip.distance = distance;
  trip.flightNumber = normalizeFlightNumber(flightNumber);

  airline = optionToCode((airline || "").toString()); // trim to ICAO
  aircraft = optionToCode((aircraft || "").toString()); // trim to IATA
  // If airline or aircraft not valid, just drop and use empty values.
  trip.airline = airlineDataMap.has(airline) ? airline : "";
  trip.aircraft = aircraftDataMap.has(aircraft) ? aircraft : "";

  trip.tailNumber = (tailNumber || "").toString().trim();
  trip.seatClass = (seatClass || "").toString().trim();
  trip.seatNumber = (seatNumber || "").toString().trim();

  // Calculate duration and distance using airport.js methods
  if (duration == null || duration == "" || !isValidDurationText(duration)) {
    trip.duration = await getDuration(
      normalizeDateTimeInput(trip.takeOffTime),
      normalizeDateTimeInput(trip.landingTime),
      trip.departureIATA,
      trip.arrivalIATA
    );
  }
  if (distance == null || distance == "" || !isValidDistanceText(distance)) {
    trip.distance = getDistance(trip.departureIATA, trip.arrivalIATA);
  }
  trip.id = constructID(trip);

  // update global var of user's trips
  trips.push(trip);
  indexTrip(trip);
  
  // Create a new row in the travel log table
  const tbody = $("#travelTbody")[0];
  const newRow = tbody.insertRow(-1); // Insert a new row at the end of the table
  for (let i = 0; i < 9; i++) {
    // Insert cells
    newRow.insertCell(i);
  }
  populateRow(trip, newRow);
  
  // if trips count went from 0 to 1 then display table
  toggleTableDisplay();
  // update storage
  if (!skipPersist) {
    await upsertTripInStorage(trip);
  }
  // Draw route on earth
  if (!skipRender) {
    drawFlightRoute(viewer, trip);
  }
}

// update trip for both UI and storage from input
async function updateTrip() {
  // if form not valid yet, alert and return doing nothing
  // explicit check is still needed because update button is type="button".
  if ($("#tripForm")[0].checkValidity() == false) {
    alert(
      "Please fill in all required fields (marked bold).\n Check airport IATA codes and takeoff/landing time."
    );
    return;
  }
  // re-fetch the IDs for editing
  const editTripID = sessionStorage.getItem("editTripID");
  const editRowIndex = sessionStorage.getItem("editRowIndex");
  if (!editTripID || editRowIndex == null) {
    alert("ERROR: No trip selected for editing.");
    resetTripFormState();
    return;
  }

  // record the updated text values in form input
  let trip = getTripById(editTripID);
  if (!trip) {
    alert("ERROR: Trip no longer exists.");
    resetTripFormState();
    return;
  }
  const prevDepartureIATA = trip.departureIATA;
  const prevArrivalIATA = trip.arrivalIATA;
  let newDIATA = normalizeIATACode($("#departureIATA").val());
  let newAIATA = normalizeIATACode($("#arrivalIATA").val());
  let newAirline = $("#airline").val();
  let newAircraft = $("#aircraft").val();
  // Updated IATA has to be correct before continue
  const validIATA = isValidAirport(newDIATA) && isValidAirport(newAIATA);
  if (!validIATA) {
    alert(
      "ERROR: Airport not found. \nPlease check your airport IATA codes or use suggested values."
    );
    return;
  }
  trip.departureIATA = newDIATA;
  trip.arrivalIATA = newAIATA;

  newAirline = optionToCode(newAirline); // trim to ICAO again
  newAircraft = optionToCode(newAircraft); // trim to IATA again
  // validate airline and aircraft, if not just make them empty
  trip.airline = airlineDataMap.has(newAirline) ? newAirline : "";
  trip.aircraft = aircraftDataMap.has(newAircraft) ? newAircraft : "";

  // update text values at last in case something went wrong before but these get updated.
  trip.departureCity = $("#departureCity").val();
  trip.arrivalCity = $("#arrivalCity").val();
  trip.takeOffTime = $("#takeOffTime").val();
  trip.landingTime = $("#landingTime").val();
  trip.flightNumber = normalizeFlightNumber($("#flightNumber").val());
  trip.tailNumber = $("#tailNumber").val();
  trip.seatClass = $("#seatClass").val();
  trip.seatNumber = $("#seatNumber").val();

  // always re-calculate these upon update
  trip.distance = getDistance(trip.departureIATA, trip.arrivalIATA);
  trip.duration = await getDuration(
    normalizeDateTimeInput(trip.takeOffTime),
    normalizeDateTimeInput(trip.landingTime),
    trip.departureIATA,
    trip.arrivalIATA
  );

  // the trip object has already been updated in place at this point
  // now update table row UI in place
  const row = $("#travelLogTable")[0].rows[editRowIndex];
  populateRow(trip, row);

  // route points/lines only need redraw when route endpoints changed.
  if (
    prevDepartureIATA !== trip.departureIATA ||
    prevArrivalIATA !== trip.arrivalIATA
  ) {
    refreshGlobeRoutes(viewer);
  }

  // update trips storage
  indexTrip(trip);
  await upsertTripInStorage(trip);
  loadStats();

  // reset add/update button status in modal
  resetTripFormState();
  modal.hide();
}

// export trips to file
async function exportToJSON() {
  const tripsStorage = await loadTripsFromStorage();
  if (tripsStorage.length < 1) {
    alert("Warning: you don't have trips currently stored.");
    return;
  }
  const jsonData = JSON.stringify(tripsStorage, null, 2); // Pretty print with 2 spaces
  const blob = new Blob([jsonData], { type: "application/json" });

  // Create a download link
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "travel-log.json"; // The file name for the download
  link.click(); // Programmatically click the download link

  // Clean up and revoke the object URL
  URL.revokeObjectURL(link.href);
}

// Main Entry
init();
