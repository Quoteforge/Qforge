const CACHE_NAME = 'qforge-v1';
const RUNTIME_CACHE = 'qforge-runtime-v1';
const SYNC_TAG = 'qforge-sync';

// Files to cache on install (app shell)
const CACHE_FILES = [
  '/',
  '/index.html',
  'https://cdn.jsdelivr.net/npm/supabase@2.48.0/+esm',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
];

// Install event - cache the app shell
self.addEventListener('install', (event) => {
  console.log('Service Worker installing...');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('Caching app shell');
      return cache.addAll(['/'].filter(url => url));
    }).then(() => self.skipWaiting())
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  console.log('Service Worker activating...');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME && cacheName !== RUNTIME_CACHE) {
            console.log('Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') {
    return;
  }

  // Skip Supabase API calls - always go to network
  if (url.hostname.includes('supabase.co')) {
    return event.respondWith(
      fetch(request).catch(() => {
        // When offline, queue for sync
        if (request.method === 'POST' || request.method === 'PUT') {
          queueForSync(request);
        }
        return new Response('Offline - changes will sync when online', { status: 503 });
      })
    );
  }

  // For HTML documents, try network first, fall back to cache
  if (request.mode === 'navigate') {
    return event.respondWith(
      fetch(request)
        .then((response) => {
          // Cache successful responses
          if (response.ok) {
            const cache = caches.open(RUNTIME_CACHE);
            cache.then((c) => c.put(request, response.clone()));
          }
          return response;
        })
        .catch(() => {
          // Fall back to cached version
          return caches.match(request).then((response) => {
            return response || caches.match('/') || new Response('Offline');
          });
        })
    );
  }

  // For everything else, use cache-first strategy
  event.respondWith(
    caches.match(request).then((response) => {
      return response || fetch(request).then((fetchResponse) => {
        // Cache successful responses
        if (fetchResponse.ok) {
          const cache = caches.open(RUNTIME_CACHE);
          cache.then((c) => c.put(request, fetchResponse.clone()));
        }
        return fetchResponse;
      }).catch(() => {
        // Return offline response for CDN resources
        if (url.hostname.includes('cdn.') || url.hostname.includes('cdnjs')) {
          return new Response('Offline - resource unavailable', { status: 503 });
        }
        return new Response('Offline');
      });
    })
  );
});

// Background Sync - sync changes when back online
self.addEventListener('sync', (event) => {
  console.log('Background sync triggered:', event.tag);
  
  if (event.tag === SYNC_TAG) {
    event.waitUntil(
      (async () => {
        try {
          // Get queued changes from IndexedDB
          const db = await openDB();
          const queue = await getAllQueuedItems(db);
          
          if (queue.length > 0) {
            console.log('Syncing', queue.length, 'items');
            
            // Try to sync each item
            for (const item of queue) {
              try {
                await fetch(item.url, {
                  method: item.method,
                  headers: item.headers,
                  body: item.body ? JSON.stringify(item.body) : undefined
                });
                
                // Remove from queue if successful
                await removeQueuedItem(db, item.id);
                
                // Notify clients
                self.clients.matchAll().then((clients) => {
                  clients.forEach((client) => {
                    client.postMessage({
                      type: 'sync-success',
                      message: 'Changes synced!'
                    });
                  });
                });
              } catch (error) {
                console.log('Sync failed for item:', item.id, error);
              }
            }
          }
        } catch (error) {
          console.error('Background sync error:', error);
          throw error;
        }
      })()
    );
  }
});

// Helper functions for IndexedDB queue
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('QForgeDB', 1);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('syncQueue')) {
        db.createObjectStore('syncQueue', { keyPath: 'id', autoIncrement: true });
      }
    };
  });
}

function getAllQueuedItems(db) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['syncQueue'], 'readonly');
    const store = transaction.objectStore('syncQueue');
    const request = store.getAll();
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function removeQueuedItem(db, id) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['syncQueue'], 'readwrite');
    const store = transaction.objectStore('syncQueue');
    const request = store.delete(id);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

function queueForSync(request) {
  openDB().then((db) => {
    const transaction = db.transaction(['syncQueue'], 'readwrite');
    const store = transaction.objectStore('syncQueue');
    
    store.add({
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: request.method !== 'GET' ? request.body : null,
      timestamp: Date.now()
    });
  }).catch((error) => {
    console.error('Failed to queue for sync:', error);
  });
}

// Message handler for client communication
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

console.log('Service Worker loaded and ready');
