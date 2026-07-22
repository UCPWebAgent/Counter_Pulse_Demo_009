import React, { useState, useEffect, useCallback, useRef } from 'react';
import { OrderState, ChatMessage, Language, MediaItem, VehicleIdentityLock, VehicleInfo, MechanicMemory } from './types';
import { processVehicleInput } from './lib/vinEngine';
import { OrderSummary } from './components/OrderSummary';
import { Conversation } from './components/Conversation';
import { AudioVisualizer } from './components/AudioVisualizer';
import { CameraModal } from './components/CameraModal';
import { HelpAgent } from './components/HelpAgent';
import { FeedbackModal } from './components/FeedbackModal';
import { PaymentModal } from './components/PaymentModal';
import { RiaSession } from './lib/gemini';
import { orchestrator } from './lib/adapters';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, AlertCircle, FileText, Download, Trash2, X } from 'lucide-react';
import { generateInvoicePDF, generateInvoiceText } from './lib/invoiceGenerator';
import { saveMediaToIDB, getMediaFromIDB, deleteMediaFromIDB } from './lib/mediaStorage';

import { CounterDesktop } from './components/CounterDesktop';
import { MechanicCallModal } from './components/MechanicCallModal';

import { ErrorBoundary } from './components/ErrorBoundary';

const resolveDraftSafeMedia = async (media: MediaItem[]): Promise<MediaItem[]> => {
  if (!media || media.length === 0) return [];
  
  const resolved = await Promise.all(media.map(async (m) => {
    let resolvedUrl = m.url;
    let resolvedThumb = m.thumbnailUrl;

    if (m.url && m.url.startsWith('idb://')) {
      try {
        const stored = await getMediaFromIDB(m.id);
        if (stored) {
          resolvedUrl = stored.dataUrl;
          if (m.thumbnailUrl && m.thumbnailUrl.startsWith('idb://')) {
            resolvedThumb = stored.thumbnailUrl || m.thumbnailUrl;
          }
        }
      } catch (err) {
        console.error("Failed to resolve IDB media url for ID " + m.id, err);
      }
    }
    
    return {
      ...m,
      url: resolvedUrl,
      thumbnailUrl: resolvedThumb
    };
  }));
  
  return resolved;
};

import { auth, loginWithGoogle, db, handleFirestoreError, OperationType, syncUserProfile } from './lib/firebase';
import { onAuthStateChanged, User, signOut } from 'firebase/auth';
import { collection, addDoc, serverTimestamp, getDocFromServer, doc, setDoc, updateDoc, query, where, orderBy, limit, onSnapshot } from 'firebase/firestore';

const INITIAL_STATE: OrderState = {
  vehicle: {},
  fluids: [],
  parts: [],
  media: [],
  mechanicName: 'Arman',
  shopName: 'ABC Auto',
  isConfirmed: false,
  status: 'draft',
  plateState: 'CA',
  needsCounterReview: true,
  fitmentConfidence: 0.8,
};

const getDeviceId = () => {
  let id = localStorage.getItem('ria_device_id');
  if (!id) {
    id = 'dev_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
    localStorage.setItem('ria_device_id', id);
  }
  return id;
};

const cleanObject = (obj: any): any => {
  if (Array.isArray(obj)) {
    return obj.map(item => cleanObject(item));
  }
  if (obj && typeof obj === 'object' && obj.constructor === Object) {
    const newObj: any = {};
    Object.keys(obj).forEach(key => {
      if (obj[key] !== undefined) {
        newObj[key] = cleanObject(obj[key]);
      }
    });
    return newObj;
  }
  return obj;
};

const stripOrderForFirestore = (order: any): any => {
  const allowed = [
    'userId', 'deviceId', 'vehicle', 'parts', 'fluids', 'media', 'status', 'isConfirmed', 
    'mechanicName', 'shopName', 'phoneNumber', 'backendOrderId', 'paymentMethod', 
    'createdAt', 'updatedAt', 'plateState', 'urgency', 'needsCounterReview', 'fitmentConfidence',
    'counterStatus', 'counterNotes', 'vinRequested', 'videoCall'
  ];
  
  const cleaned: any = {};
  allowed.forEach(key => {
    if (order[key] !== undefined) {
      cleaned[key] = cleanObject(order[key]);
    }
  });
  
  // Guarantee required fields as per firestore.rules Schema constraints
  if (cleaned.isConfirmed === undefined) cleaned.isConfirmed = false;
  if (cleaned.needsCounterReview === undefined) cleaned.needsCounterReview = true;
  if (cleaned.fitmentConfidence === undefined) cleaned.fitmentConfidence = 0.8;
  if (cleaned.status === undefined) cleaned.status = 'draft';
  
  return cleaned;
};

const App: React.FC = () => {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [orderState, setOrderState] = useState<OrderState>(INITIAL_STATE);
  const [selectedLanguage, setSelectedLanguage] = useState<Language>('auto');
  const [activeTab, setActiveTab] = useState<'conversation' | 'input' | 'summary'>('input');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [appMode, setAppMode] = useState<'mechanic' | 'counter'>(() => {
    if (window.location.pathname === '/counter' || window.location.search.includes('mode=counter')) {
      return 'counter';
    }
    return 'mechanic';
  });

  // Stable references to prevent stale closures inside long-lived RiaSession callbacks
  const orderStateRef = useRef<OrderState>(INITIAL_STATE);
  const messagesRef = useRef<ChatMessage[]>([]);
  const saveActiveDraftRef = useRef<Function | null>(null);

  useEffect(() => {
    orderStateRef.current = orderState;
    if (sessionRef.current) {
      sessionRef.current.updateActiveDraft(orderState);
    }
  }, [orderState]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const [isListening, setIsListening] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isFirebaseReady, setIsFirebaseReady] = useState(true);
  const [agentName, setAgentName] = useState<string>('');
  const agentNameRef = useRef<string>('');
  useEffect(() => {
    agentNameRef.current = agentName;
  }, [agentName]);
  const [deviceId] = useState<string>(getDeviceId());
  const [cameraMode, setCameraMode] = useState<'photo' | 'video' | 'vin' | 'plate' | null>(null);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState<'card' | 'paypal'>('card');
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false);
  const wasListeningBeforeHelp = useRef(false);
  const [transcription, setTranscription] = useState<string>('');
  const [completedOrders, setCompletedOrders] = useState<OrderState[]>([]);
  const [showSaveOptions, setShowSaveOptions] = useState(false);
  const sessionRef = useRef<RiaSession | null>(null);

  const [historyOrders, setHistoryOrders] = useState<OrderState[]>([]);
  const [selectedMedia, setSelectedMedia] = useState<MediaItem | null>(null);
  const [mechanicMemory, setMechanicMemory] = useState<MechanicMemory | null>(null);
  const [draftStatus, setDraftStatus] = useState<'saved' | 'restored' | null>(null);

  const saveMechanicMemory = useCallback(async (updates: Partial<MechanicMemory>) => {
    if (!user) return;
    
    const memoryRef = doc(db, 'mechanic_memory', user.uid);
    const updatedMemory = {
      ...updates,
      userId: user.uid, // Always include userId for new docs
      updatedAt: serverTimestamp()
    };
    
    try {
      await setDoc(memoryRef, updatedMemory, { merge: true });
      setMechanicMemory(prev => prev ? { ...prev, ...updates } : null);
    } catch (error) {
      console.error("Error saving mechanic memory:", error);
      // We don't want to throw here to avoid crashing the app on auto-save
      // but we can log more details
      if (error instanceof Error && error.message.includes('permission')) {
        console.warn("Permission denied for mechanic memory save. Check firestore rules.");
      }
    }
  }, [user]);

  const saveActiveDraft = useCallback(async (currentOrderState: OrderState, currentMessages: ChatMessage[]) => {
    const isCompleted = currentOrderState.status === 'confirmed' || currentOrderState.isConfirmed;
    const hasData = !!(
      currentOrderState.vehicle?.year || 
      currentOrderState.vehicle?.vin || 
      (currentOrderState.parts && currentOrderState.parts.length > 0) || 
      (currentOrderState.fluids && currentOrderState.fluids.length > 0) ||
      (currentOrderState.media && currentOrderState.media.length > 0)
    );

    const makeMediaDraftSafe = (media: MediaItem[]): MediaItem[] => {
      if (!media) return [];
      return media.map(m => ({
        ...m,
        url: m.url && m.url.startsWith('data:') ? `idb://${m.id}` : m.url,
        thumbnailUrl: m.thumbnailUrl && m.thumbnailUrl.startsWith('data:') ? `idb://${m.id}-thumb` : m.thumbnailUrl
      }));
    };

    const draftSafeState = {
      ...currentOrderState,
      media: makeMediaDraftSafe(currentOrderState.media || [])
    };

    if (isCompleted) {
      try {
        localStorage.removeItem('ria_last_draft_order');
        localStorage.removeItem('ria_last_draft_messages');
      } catch (err) {}
      if (user) {
        try {
          const memoryRef = doc(db, 'mechanic_memory', user.uid);
          await setDoc(memoryRef, {
            lastDraft: null,
            recentHistory: null,
            updatedAt: serverTimestamp()
          }, { merge: true });
        } catch (error) {
          console.warn("Firestore clear draft in mechanic_memory failed:", error);
        }
      }
      return;
    }

    // 1. Local storage instant persistence (backup recovery layer)
    try {
      localStorage.setItem('ria_last_draft_order', JSON.stringify(draftSafeState));
      localStorage.setItem('ria_last_draft_messages', JSON.stringify(currentMessages));
      setDraftStatus('saved');
      setTimeout(() => setDraftStatus(null), 3000);
    } catch (err) {
      console.error("Local storage save failed:", err);
    }

    if (!user) return;

    const currentAgentName = agentNameRef.current || agentName || mechanicMemory?.preferences?.agentName || '';

    // 2. Persistent draft storage on Firestore under mechanic_memory
    try {
      const memoryRef = doc(db, 'mechanic_memory', user.uid);
      await setDoc(memoryRef, {
        lastDraft: cleanObject(draftSafeState),
        recentHistory: cleanObject(currentMessages.slice(-20)),
        userId: user.uid,
        updatedAt: serverTimestamp(),
        preferences: {
          mechanicName: currentOrderState.mechanicName || '',
          shopName: currentOrderState.shopName || '',
          language: selectedLanguage,
          agentName: currentAgentName
        }
      }, { merge: true });

      // Keep React mechanicMemory state locally in sync with the saved document
      setMechanicMemory(prev => {
        const updated = {
          ...prev,
          lastDraft: cleanObject(draftSafeState),
          recentHistory: cleanObject(currentMessages.slice(-20)),
          userId: user.uid,
          preferences: {
            ...(prev?.preferences || {}),
            mechanicName: currentOrderState.mechanicName || prev?.preferences?.mechanicName || '',
            shopName: currentOrderState.shopName || prev?.preferences?.shopName || '',
            language: selectedLanguage,
            agentName: currentAgentName
          }
        } as MechanicMemory;
        return updated;
      });
    } catch (error) {
      console.warn("Firestore save draft to mechanic_memory failed:", error);
    }

    // 3. Keep standard orders collection draft in sync if it has identified details
    if (hasData) {
      try {
        const path = 'orders';
        if (currentOrderState.id) {
          const stripped = stripOrderForFirestore({
            ...draftSafeState,
            updatedAt: serverTimestamp()
          });
          await updateDoc(doc(db, path, currentOrderState.id), stripped);
        } else {
          const draftToSave = {
            ...draftSafeState,
            userId: user.uid,
            deviceId: deviceId,
            status: 'draft' as const,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          };
          const stripped = stripOrderForFirestore(draftToSave);
          const docRef = await addDoc(collection(db, path), stripped);
          setOrderState(prev => {
            if (!prev.id) return { ...prev, id: docRef.id };
            return prev;
          });
        }
      } catch (error) {
        console.warn("Firestore save draft to orders collection failed:", error);
      }
    }
  }, [user, deviceId, selectedLanguage, agentName]);

  useEffect(() => {
    saveActiveDraftRef.current = saveActiveDraft;
  }, [saveActiveDraft]);

  // Load from localStorage immediately on mount for instant client-side draft recovery
  useEffect(() => {
    try {
      const localDraft = localStorage.getItem('ria_last_draft_order');
      const localMessages = localStorage.getItem('ria_last_draft_messages');
      if (localDraft) {
        const parsedDraft = JSON.parse(localDraft) as OrderState;
        if (parsedDraft && 
            parsedDraft.status !== 'confirmed' && 
            !parsedDraft.isConfirmed &&
            (parsedDraft.vehicle?.vin || parsedDraft.vehicle?.year || parsedDraft.parts?.length > 0 || parsedDraft.fluids?.length > 0 || (parsedDraft.media && parsedDraft.media.length > 0))) {
          console.log("Restored draft order from localStorage:", parsedDraft);
          
          resolveDraftSafeMedia(parsedDraft.media || []).then((resolvedMedia) => {
            const fullyResolved = { ...parsedDraft, media: resolvedMedia };
            setOrderState(fullyResolved);
            orderStateRef.current = fullyResolved;
          });

          setDraftStatus('restored');
          setTimeout(() => setDraftStatus(null), 4000);
        }
      }
      if (localMessages) {
        const parsedMessages = JSON.parse(localMessages) as ChatMessage[];
        if (parsedMessages && parsedMessages.length > 0) {
          console.log("Restored chat history from localStorage:", parsedMessages.length);
          setMessages(parsedMessages);
          messagesRef.current = parsedMessages;
        }
      }
    } catch (err) {
      console.error("Local storage draft recovery failed:", err);
    }
  }, []);

  // Sync state to local storage on browser unload
  useEffect(() => {
    const handleUnload = () => {
      try {
        const currentOrder = orderStateRef.current;
        const currentMsgs = messagesRef.current;
        const isCompleted = currentOrder.status === 'confirmed' || currentOrder.isConfirmed;
        if (isCompleted) {
          localStorage.removeItem('ria_last_draft_order');
          localStorage.removeItem('ria_last_draft_messages');
        } else {
          const makeMediaDraftSafe = (media: MediaItem[]): MediaItem[] => {
            if (!media) return [];
            return media.map(m => ({
              ...m,
              url: m.url && m.url.startsWith('data:') ? `idb://${m.id}` : m.url,
              thumbnailUrl: m.thumbnailUrl && m.thumbnailUrl.startsWith('data:') ? `idb://${m.id}-thumb` : m.thumbnailUrl
            }));
          };
          const draftSafeOrder = {
            ...currentOrder,
            media: makeMediaDraftSafe(currentOrder.media || [])
          };
          localStorage.setItem('ria_last_draft_order', JSON.stringify(draftSafeOrder));
          localStorage.setItem('ria_last_draft_messages', JSON.stringify(currentMsgs));
        }
      } catch (err) {
        console.error("Failed to save/clear draft to localStorage on unload:", err);
      }
    };
    window.addEventListener('beforeunload', handleUnload);
    return () => {
      window.removeEventListener('beforeunload', handleUnload);
    };
  }, []);

  // Unified Auto-Save Debouncer Effect (Fast 1.5s interval for instant database recollection)
  useEffect(() => {
    const timer = setTimeout(() => {
      saveActiveDraft(orderState, messages);
    }, 1500); // 1.5s debounce for instant backup and recollection

    return () => clearTimeout(timer);
  }, [orderState, messages, saveActiveDraft]);

  useEffect(() => {
    if (!user) {
      setHistoryOrders([]);
      return;
    }

    const ordersRef = collection(db, 'orders');
    const q = query(
      ordersRef,
      where('userId', '==', user.uid),
      limit(50)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const orders = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as any[];
      
      // Sort in memory to avoid index requirements and handle null timestamps
      const sortedOrders = orders.sort((a, b) => {
        const timeA = a.updatedAt?.toMillis?.() || a.updatedAt || 0;
        const timeB = b.updatedAt?.toMillis?.() || b.updatedAt || 0;
        return timeB - timeA;
      });

      setHistoryOrders(sortedOrders);
      console.log(`Loaded ${orders.length} global historical orders for user ${user.uid}`);
    }, (error) => {
      if (error?.code === 'permission-denied' || error?.message?.toLowerCase()?.includes('permission') || error?.message?.toLowerCase()?.includes('insufficient')) {
        handleFirestoreError(error, OperationType.LIST, 'orders');
      } else {
        console.warn("Background global historical sync warning (non-fatal):", error);
      }
    });

    return () => unsubscribe();
  }, [user]);

  useEffect(() => {
    setOrderState(prev => ({ ...prev, deviceId }));
  }, [deviceId]);

  useEffect(() => {
    const testConnection = async () => {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        if(error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration.");
          setIsFirebaseReady(false);
        }
      }
    };
    testConnection();

    const checkKey = async () => {
      // Prioritize environment key for a "clean" experience
      if (process.env.GEMINI_API_KEY) {
        setHasApiKey(true);
        return;
      }

      if (window.aistudio) {
        const hasKey = await window.aistudio.hasSelectedApiKey();
        setHasApiKey(hasKey);
      }
    };
    checkKey();
  }, []);

  const handleLogout = async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error("Logout failed:", error);
    }
  };

  const handleSelectKey = async () => {
    if (window.aistudio) {
      try {
        await window.aistudio.openSelectKey();
        setHasApiKey(true);
      } catch (error) {
        console.error("Key selection failed:", error);
        alert("Failed to select API key. Please try again.");
      }
    } else {
      alert("To use Ria's voice features, please open this app through the AI Studio 'Build' interface or the 'Share' link. Direct links require manual API key configuration.");
    }
  };

  useEffect(() => {
    if (isHelpOpen) {
      if (isListening) {
        wasListeningBeforeHelp.current = true;
        stopSession();
      } else {
        wasListeningBeforeHelp.current = false;
      }
    } else {
      if (wasListeningBeforeHelp.current) {
        startSession();
        wasListeningBeforeHelp.current = false;
      }
    }
  }, [isHelpOpen]);

  const handleVehicleIdentification = async (text: string) => {
    // If vehicle is already locked and confirmed, don't auto-process unless it's a reset
    if (orderStateRef.current.vehicleIdentityLock?.isConfirmed) return;

    // Try VIN first
    let result = await processVehicleInput(text, 'vin', orderStateRef.current.plateState || 'CA');
    
    // If no VIN candidate, try Plate
    if (result.status === 'NO_CANDIDATE') {
      result = await processVehicleInput(text, 'plate', orderStateRef.current.plateState || 'CA');
    }

    if (result.status !== 'NO_CANDIDATE') {
      console.log('Vehicle Identification Result:', result);
      
      const update: Partial<OrderState> = {
        vehicleIdentityLock: result as VehicleIdentityLock
      };

      if (result.decodeResult) {
        update.vehicle = result.decodeResult;
      }

      handleUpdateState(update);

      // If we have a result, inform Gemini so it can ask for confirmation
      if (sessionRef.current && result.status === 'CONFIRMATION_REQUIRED') {
        const v = result.decodeResult;
        const vehicleStr = v ? `${v.year} ${v.make} ${v.model} ${v.trim || ''}`.trim() : 'vehicle';
        sessionRef.current.sendText(`[SYSTEM: Identified ${vehicleStr} from ${result.inputType}. Please ask user to confirm including the trim.]`);
      }
    }
  };

  const handleUpdateMessage = useCallback((text: string) => {
    setMessages((prev) => {
      const next: ChatMessage[] = [...prev, { role: 'assistant' as const, text, timestamp: Date.now() }];
      messagesRef.current = next;
      if (saveActiveDraftRef.current) {
        saveActiveDraftRef.current(orderStateRef.current, next);
      } else {
        saveActiveDraft(orderStateRef.current, next);
      }
      return next;
    });
    setIsSpeaking(true);
    setTranscription(''); // Clear transcription when a full message arrives
  }, []);

  const handleUserSpokenText = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setMessages((prev) => {
      if (prev.length > 0) {
        const lastMsg = prev[prev.length - 1];
        if (lastMsg.role === 'user' && lastMsg.text.trim() === trimmed) {
          return prev;
        }
      }
      const next: ChatMessage[] = [...prev, { role: 'user' as const, text: trimmed, timestamp: Date.now() }];
      messagesRef.current = next;
      if (saveActiveDraftRef.current) {
        saveActiveDraftRef.current(orderStateRef.current, next);
      } else {
        saveActiveDraft(orderStateRef.current, next);
      }
      return next;
    });
  }, []);

  const handleTranscription = useCallback((text: string) => {
    setTranscription(text);
    // Spoken input: treat transcript as candidate source only
    if (text.length > 5) {
      handleVehicleIdentification(text);
    }
  }, []);

  const handleUpdateState = useCallback((update: Partial<OrderState>) => {
    setOrderState((prev) => {
      const newState = { ...prev, ...update };
      
      // Merge vehicle info specifically
      if (update.vehicle) {
        newState.vehicle = { ...prev.vehicle, ...update.vehicle };
      }

      // Handle vehicle identity lock updates
      if (update.vehicleIdentityLock) {
        newState.vehicleIdentityLock = { 
          ...(prev.vehicleIdentityLock || {}), 
          ...update.vehicleIdentityLock 
        } as VehicleIdentityLock;
      } else if (update.vehicleIdentityLock === null) {
        newState.vehicleIdentityLock = undefined;
      }
      
      // Only append if the update actually contains new items; if empty array, clear the list
      if (update.fluids !== undefined) {
        if (update.fluids.length === 0) {
          newState.fluids = [];
        } else {
          const existingIds = new Set(prev.fluids.map(f => `${f.subcategory}-${f.spec}`));
          const newFluids = update.fluids.filter(f => !existingIds.has(`${f.subcategory}-${f.spec}`));
          newState.fluids = [...prev.fluids, ...newFluids];
        }
      }
      if (update.parts !== undefined) {
        if (update.parts.length === 0) {
          newState.parts = [];
        } else {
          const existingNames = new Set(prev.parts.map(p => p.name.toLowerCase()));
          const newParts = update.parts.filter(p => !existingNames.has(p.name.toLowerCase()));
          newState.parts = [...prev.parts, ...newParts];
        }
      }
      if (update.media !== undefined) {
        if (update.media.length === 0) {
          newState.media = [];
        } else {
          const existingIds = new Set(prev.media.map(m => m.id));
          const newMedia = update.media.filter(m => !existingIds.has(m.id));
          newState.media = [...prev.media, ...newMedia];
        }
      }

      orderStateRef.current = newState;
      if (saveActiveDraftRef.current) {
        saveActiveDraftRef.current(newState, messagesRef.current);
      } else {
        saveActiveDraft(newState, messagesRef.current);
      }
      return newState;
    });
  }, []);

  const handleCapture = (type: 'photo' | 'video' | 'vin' | 'plate') => {
    setCameraMode(type);
  };

  const onCameraCapture = (dataUrl: string, type: 'photo' | 'video' | 'vin' | 'plate', thumbnailUrl?: string, ocrText?: string) => {
    console.log(`${type} captured from modal`);
    
    if (type === 'vin' || type === 'plate') {
      if (ocrText) {
        handleVehicleIdentification(ocrText);
      }
      return;
    }

    const mediaId = Math.random().toString(36).substr(2, 9);
    
    // Save locally to IndexedDB for high-performance offline draft preservation
    saveMediaToIDB(mediaId, dataUrl, thumbnailUrl).then(() => {
      console.log(`Successfully saved media to IndexedDB: ${mediaId}`);
    }).catch(err => {
      console.error("Failed to save media to IndexedDB", err);
    });

    const newItem: MediaItem = {
      id: mediaId,
      type: type as 'photo' | 'video',
      url: dataUrl,
      thumbnailUrl: type === 'video' ? thumbnailUrl : undefined,
      timestamp: Date.now(),
    };
    setOrderState(prev => {
      const updatedMedia = [...prev.media, newItem];
      const newState = { ...prev, media: updatedMedia };
      // Save instantly to Firestore and localStorage
      saveActiveDraft(newState, messages);
      return newState;
    });
  };

  const handleDownloadMedia = (item: MediaItem) => {
    try {
      const link = document.createElement('a');
      link.href = item.url;
      link.download = `ria_captured_${item.id}_${item.timestamp}.${item.type === 'photo' ? 'png' : 'webm'}`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      console.error("Error triggering media download:", err);
    }
  };

  const handleDeleteMedia = (mediaId: string) => {
    // Clean up local IndexedDB entry
    deleteMediaFromIDB(mediaId).then(() => {
      console.log(`Cleaned up media from IndexedDB: ${mediaId}`);
    }).catch(err => {
      console.error("Failed to clean up media from IndexedDB", err);
    });

    setOrderState((prev) => {
      const updatedMedia = prev.media.filter(m => m.id !== mediaId);
      const newState = { ...prev, media: updatedMedia };
      saveActiveDraft(newState, messages);
      return newState;
    });
    setSelectedMedia(null);
  };

  const handleInterrupted = useCallback(() => {
    setIsSpeaking(false);
    setMessages((prev) => [...prev, { role: 'assistant', text: "[Interrupted]", timestamp: Date.now() }]);
  }, []);

  const handleLanguageChange = (lang: Language) => {
    setSelectedLanguage(lang);
    if (isListening) {
      stopSession();
      // Small delay to ensure cleanup before restart
      setTimeout(() => {
        startSession(lang);
      }, 100);
    }
  };

  const getHistoryContext = useCallback(() => {
    if (historyOrders.length === 0) return "";
    
    const summary = historyOrders.map(order => {
      const v = order.vehicle;
      const vehicleStr = v ? `${v.year || ''} ${v.make || ''} ${v.model || ''} ${v.trim || ''}`.trim() : "Unknown Vehicle";
      const vinStr = v?.vin ? ` (VIN: ${v.vin})` : "";
      const plateStr = v?.licensePlate ? ` (Plate: ${v.licensePlate} [${v.plateState || order.plateState || ''}])` : "";
      
      const partsDetail = order.parts && order.parts.length > 0
        ? order.parts.map((p: any) => {
            const qty = p.quantity || 1;
            const brand = p.brand ? `, Brand: ${p.brand}` : "";
            const pn = p.partNumber ? `, Part#: ${p.partNumber}` : "";
            const notes = p.notes ? `, Notes: ${p.notes}` : "";
            return `  * Part: ${p.name} (Qty: ${qty}${brand}${pn}${notes})`;
          }).join('\n')
        : "";

      const fluidsDetail = order.fluids && order.fluids.length > 0
        ? order.fluids.map((f: any) => {
            const spec = f.spec ? `, Spec: ${f.spec}` : "";
            const qty = f.quantity ? `, Qty: ${f.quantity}` : "";
            const brand = f.brand ? `, Brand: ${f.brand}` : "";
            const type = f.type ? `, Type: ${f.type}` : "";
            return `  * Fluid: ${f.subcategory}${spec}${qty}${brand}${type}`;
          }).join('\n')
        : "";

      const dateStr = order.createdAt && typeof order.createdAt.toDate === 'function'
        ? order.createdAt.toDate().toLocaleDateString()
        : order.createdAt?.seconds
          ? new Date(order.createdAt.seconds * 1000).toLocaleDateString()
          : order.createdAt
            ? new Date(order.createdAt).toLocaleDateString()
            : 'Unknown Date';

      const orderMetadata = `Order Date: ${dateStr}, Status: ${order.status || 'draft'}, Urgency: ${order.urgency || 'normal'}`;
      
      return `[Vehicle: ${vehicleStr}${vinStr}${plateStr}]\n- ${orderMetadata}\n${partsDetail || '  * No parts listed'}${fluidsDetail ? '\n' + fluidsDetail : ''}`;
    }).join('\n\n');

    return `\nHISTORICAL CONTEXT of all past orders made by this mechanic:\n${summary}\n\nUse this data to answer questions about past orders. If the mechanic asks about a previous order (e.g., brand of filter, date of last service, what was done to a 2018 Camry), refer to this list. Recognize returning vehicles, search across all fields of these past orders, and recall any previous parts/fluids details. Keep answers short and precise.`;
  }, [historyOrders]);

  const handleResetOrder = useCallback(async () => {
    setOrderState({
      ...INITIAL_STATE,
      deviceId,
      mechanicName: orderState.mechanicName,
      shopName: orderState.shopName,
    });
    setMessages([{
      role: 'assistant',
      text: "Order reset. I'm ready for the next vehicle. Please provide the vehicle details.",
      timestamp: Date.now()
    }]);

    // Clear local storage instantly
    try {
      localStorage.removeItem('ria_last_draft_order');
      localStorage.removeItem('ria_last_draft_messages');
    } catch (err) {
      console.error("Local storage clear failed in reset:", err);
    }

    // Clear cloud persistent draft in mechanic_memory
    if (user) {
      try {
        const memoryRef = doc(db, 'mechanic_memory', user.uid);
        await setDoc(memoryRef, {
          lastDraft: null,
          recentHistory: null,
          updatedAt: serverTimestamp()
        }, { merge: true });
        
        setMechanicMemory(prev => prev ? {
          ...prev,
          lastDraft: null,
          recentHistory: null
        } : null);
      } catch (error) {
        console.warn("Firestore clear draft in mechanic_memory failed:", error);
      }
    }
  }, [user, deviceId, orderState.mechanicName, orderState.shopName]);

  const startSession = async (langOverride?: Language) => {
    if (isConnecting || isListening) return;
    
    setIsConnecting(true);

    if (!hasApiKey && !process.env.GEMINI_API_KEY) {
      if (window.aistudio) {
        await handleSelectKey();
        // Assume success after dialog to avoid race condition
        setHasApiKey(true);
      } else {
        alert("Gemini API Key is required for voice features. Please use the 'Share' link from AI Studio.");
        setIsConnecting(false);
        return;
      }
    }

    if (!sessionRef.current) {
      const historyContext = getHistoryContext();
      const session = new RiaSession(
        handleUpdateMessage,
        handleUpdateState,
        handleInterrupted,
        () => setIsSpeaking(false), // onSpeakingEnd
        handleTranscription,
        langOverride || selectedLanguage,
        undefined, // Use default system instruction
        mechanicMemory || undefined,
        (fact) => {
          console.log("Ria learned a new fact:", fact);
          if (saveActiveDraftRef.current) {
            saveActiveDraftRef.current(orderStateRef.current, messagesRef.current);
          } else {
            saveActiveDraft(orderStateRef.current, messagesRef.current);
          }
        },
        (name) => {
          console.log("Setting agent name to:", name);
          agentNameRef.current = name;
          setAgentName(name);
          if (user) {
            const memoryRef = doc(db, 'mechanic_memory', user.uid);
            setDoc(memoryRef, {
              preferences: {
                agentName: name
              }
            }, { merge: true }).catch(err => console.error("Error setting agent name on firestore:", err));
          }
          if (saveActiveDraftRef.current) {
            saveActiveDraftRef.current(orderStateRef.current, messagesRef.current);
          } else {
            saveActiveDraft(orderStateRef.current, messagesRef.current);
          }
        },
        orderStateRef.current, // Pass active draft order so Ria connects with full awareness of context
        handleResetOrder,
        messagesRef.current, // Pass full active conversation history for seamless resume
        handleUserSpokenText // Handle User transcription to keep chat logs synchronized and saved
      );
      
      try {
        await session.connect();
        sessionRef.current = session;
        setIsListening(true);
        
        // Send historical context as a hidden prompt if available
        if (historyContext) {
          await session.sendText(`[SYSTEM CONTEXT: ${historyContext}] Please acknowledge internally but do not repeat this to the user unless relevant.`);
        }
      } catch (error) {
        console.error("Session connection failed:", error);
        setMessages(prev => {
          const next = [...prev, { 
            role: 'assistant' as const, 
            text: "Failed to connect to Ria. Please check your internet connection and API key.", 
            timestamp: Date.now() 
          }];
          messagesRef.current = next;
          return next;
        });
      } finally {
        setIsConnecting(false);
      }
    } else {
      setIsConnecting(false);
    }
  };

  const stopSession = async () => {
    // Save draft immediately to Firestore & localStorage
    await saveActiveDraft(orderStateRef.current, messagesRef.current);
    if (sessionRef.current) {
      await sessionRef.current.close();
      sessionRef.current = null;
      setIsListening(false);
      setIsSpeaking(false);
      setTranscription('');
    }
  };

  const toggleMic = async () => {
    if (isConnecting) return;
    
    if (isListening) {
      await stopSession();
    } else {
      await startSession();
    }
  };

  const handleToggleConfirm = () => {
    console.log("handleToggleConfirm called");
    setOrderState((prev) => {
      const nextConfirmed = !prev.isConfirmed;
      const newState = { ...prev, isConfirmed: nextConfirmed };
      orderStateRef.current = newState;
      
      // Update active draft instantly in the active session
      if (sessionRef.current) {
        sessionRef.current.updateActiveDraft(newState);
      }
      
      // Save draft instantly
      saveActiveDraft(newState, messagesRef.current);
      
      // Notify active Gemini session
      if (sessionRef.current) {
        sessionRef.current.sendText(`[SYSTEM INFO: The mechanic has manually ${nextConfirmed ? 'CHECKED' : 'UNCHECKED'} the confirmation checkbox in the Order tab. The order is now ${nextConfirmed ? 'AUTHORIZED AND READY TO SUBMIT. Inform them they can click the "Confirm Order" button to submit/process the order now, or ask if they are ready for you to do anything else' : 'NOT AUTHORIZED. Instruct them to check the box when they are ready'}.]`);
      }
      return newState;
    });
  };

  const handleSubmitOrder = async () => {
    console.log("handleSubmitOrder called, isConfirmed:", orderStateRef.current.isConfirmed);
    if (user) {
      // Force isConfirmed to true and update state since the user clicked the manual submit button
      const confirmedState = { ...orderStateRef.current, isConfirmed: true };
      setOrderState(confirmedState);
      orderStateRef.current = confirmedState;
      if (sessionRef.current) {
        sessionRef.current.updateActiveDraft(confirmedState);
      }
      await saveActiveDraft(confirmedState, messagesRef.current);
      
      await handleProcessPayment('Account');
    }
  };

  const handlePayOrder = async (method: 'card' | 'paypal') => {
    console.log("handlePayOrder called with method:", method);
    if (user) {
      setSelectedPaymentMethod(method);
      setShowPaymentModal(true);
    }
  };

  const handleProcessPayment = async (method: string, details?: any) => {
    if (!user) return;
    
    try {
      const currentOrder = orderStateRef.current;
      const finalOrder: OrderState = {
        ...currentOrder,
        userId: user.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        status: 'confirmed' as const,
        paymentMethod: method,
        needsCounterReview: false, // Once confirmed, it's ready for fulfillment
        fitmentConfidence: 1.0, // Confirmed by human
      };

      // 1. Dispatch through adapters (Software-Agnostic Routing)
      const adapterResults = await orchestrator.dispatch(finalOrder);
      console.log("Orchestrator dispatch results:", adapterResults);

      const successfulAdapter = adapterResults.find(r => r.success);
      if (successfulAdapter) {
        finalOrder.backendOrderId = successfulAdapter.externalId;
      }

      // 2. Store in memory for UI
      setCompletedOrders(prev => [{ ...finalOrder, createdAt: new Date().toISOString() }, ...prev]);

      // 3. Save to Firestore (Primary Storage Layer)
      const path = 'orders';
      const strippedOrder = stripOrderForFirestore(finalOrder);
      if (currentOrder.id) {
        await updateDoc(doc(db, path, currentOrder.id), strippedOrder);
        finalOrder.id = currentOrder.id;
      } else {
        const docRef = await addDoc(collection(db, path), strippedOrder);
        finalOrder.id = docRef.id;
      }
      
      // 3.5. Immediately clear active draft recovery layers from client & server memory
      try {
        localStorage.removeItem('ria_last_draft_order');
        localStorage.removeItem('ria_last_draft_messages');
      } catch (err) {}

      try {
        const memoryRef = doc(db, 'mechanic_memory', user.uid);
        await setDoc(memoryRef, {
          lastDraft: null,
          recentHistory: null,
          updatedAt: serverTimestamp()
        }, { merge: true });
      } catch (err) {}
      
      let methodText = '';
      if (method === 'Account') {
        methodText = 'Monthly Account';
      } else if (method === 'youtube') {
        methodText = 'YouTube';
      } else if (method === 'paypal') {
        methodText = 'PayPal';
      } else {
        methodText = 'Credit Card';
      }

      // 4. Notify Ria if session is active
      if (sessionRef.current) {
        sessionRef.current.setLastSubmittedOrder(finalOrder);
        await sessionRef.current.sendText(`[SYSTEM: The order has been successfully submitted and processed via ${methodText}. Please congratulate the mechanic and ask if they need help with a new vehicle or another task.]`);
      }

      // 5. Reset order state for next transaction
      setOrderState({
        ...INITIAL_STATE,
        deviceId,
        mechanicName: currentOrder.mechanicName,
        shopName: currentOrder.shopName,
      });
      
      setMessages((prev) => [
        ...prev, 
        { 
          role: 'assistant', 
          text: `Order confirmed and processed via ${methodText}! The request has been routed to the shop dashboard and backend systems. Lav e, gortse verchatsav!`, 
          timestamp: Date.now() 
        }
      ]);
      setShowPaymentModal(false);
    } catch (error) {
      console.error("Submission failed:", error);
      handleFirestoreError(error, OperationType.CREATE, 'orders');
    }
  };

  const handleSaveToPhone = (format: 'pdf' | 'text') => {
    if (format === 'pdf') {
      generateInvoicePDF(orderState);
    } else {
      generateInvoiceText(orderState);
    }
    setShowSaveOptions(false);
  };

  const handleSendText = (text: string) => {
    const trimmedText = text.trim();
    if (!trimmedText) return;

    // Typed input: route through deterministic pipeline
    handleVehicleIdentification(trimmedText);

    if (sessionRef.current) {
      sessionRef.current.sendText(trimmedText);
      setMessages((prev) => [...prev, { role: 'user', text: trimmedText, timestamp: Date.now() }]);
    } else {
      // If no session, start one and then send text
      startSession().then(() => {
        if (sessionRef.current) {
          sessionRef.current.sendText(trimmedText);
          setMessages((prev) => [...prev, { role: 'user', text: trimmedText, timestamp: Date.now() }]);
        }
      });
    }
  };



  const handleSaveOrder = async () => {
    if (user) {
      try {
        const path = 'orders';
        if (orderState.id) {
          const stripped = stripOrderForFirestore({
            ...orderState,
            updatedAt: serverTimestamp()
          });
          await updateDoc(doc(db, path, orderState.id), stripped);
        } else {
          const stripped = stripOrderForFirestore({
            ...orderState,
            userId: user.uid,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            status: 'draft'
          });
          const docRef = await addDoc(collection(db, path), stripped);
          setOrderState(prev => {
            const next = { ...prev, id: docRef.id };
            orderStateRef.current = next;
            return next;
          });
        }
        setMessages(prev => {
          const next = [...prev, { 
            role: 'assistant' as const, 
            text: "Order saved as draft. You can access it later from this device.", 
            timestamp: Date.now() 
          }];
          messagesRef.current = next;
          return next;
        });
      } catch (error) {
        console.error("Save failed:", error);
        handleFirestoreError(error, OperationType.WRITE, 'orders');
      }
    }
  };

  const handleFeedback = () => {
    setIsFeedbackOpen(true);
  };

  const handleSubmitFeedback = async (text: string) => {
    try {
      const path = 'feedback';
      await addDoc(collection(db, path), cleanObject({
        text,
        userId: user?.uid || null,
        userEmail: user?.email || null,
        deviceId: deviceId || null,
        targetEmail: 'beta@ucp-demo.online',
        timestamp: serverTimestamp(),
        status: 'new'
      }));
    } catch (error) {
      console.error("Feedback submission failed:", error);
      handleFirestoreError(error, OperationType.WRITE, 'feedback');
    }
  };

  const handleLoadOrder = (order: OrderState) => {
    const nextState = {
      ...order,
      id: undefined, // Clear ID to treat as new draft
      status: 'draft' as const,
      isConfirmed: true,
      createdAt: undefined,
      updatedAt: undefined
    };
    setOrderState(nextState);
    orderStateRef.current = nextState;
    setActiveTab('input');
    setMessages(prev => {
      const next = [...prev, {
        role: 'assistant' as const,
        text: `Loaded order for ${order.vehicle.year} ${order.vehicle.make} ${order.vehicle.model} as a new draft.`,
        timestamp: Date.now()
      }];
      messagesRef.current = next;
      return next;
    });
  };

  useEffect(() => {
    const handleVisibilityChange = async () => {
      // Wake lock removed due to environment restrictions
    };
    
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isListening]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setUser(user);
      setAuthLoading(false);
      if (user) {
        setOrderState(prev => ({ ...prev, userId: user.uid }));
        // Sync user profile to Firestore
        if (!user.isAnonymous) {
          syncUserProfile(user);
        }

        // Fetch persistent memory
        const memoryRef = doc(db, 'mechanic_memory', user.uid);
        try {
          const memorySnap = await getDocFromServer(memoryRef);
          if (memorySnap.exists()) {
            const memoryData = memorySnap.data() as MechanicMemory;
            setMechanicMemory(memoryData);
            
            // Unconditionally restore last draft if available on server
            if (memoryData.lastDraft && 
                memoryData.lastDraft.status !== 'confirmed' &&
                !memoryData.lastDraft.isConfirmed) {
              
              resolveDraftSafeMedia(memoryData.lastDraft.media || []).then((resolvedMedia) => {
                const fullyResolved = { ...memoryData.lastDraft, media: resolvedMedia };
                setOrderState(fullyResolved as OrderState);
                orderStateRef.current = fullyResolved as OrderState;
              });

              setDraftStatus('restored');
              setTimeout(() => setDraftStatus(null), 4000);
            }
            
            // Unconditionally restore recent history if available on server
            if (memoryData.recentHistory && memoryData.recentHistory.length > 0) {
              setMessages(memoryData.recentHistory);
              messagesRef.current = memoryData.recentHistory;
            }

            // Restore preferences
            if (memoryData.preferences?.language) {
              setSelectedLanguage(memoryData.preferences.language);
            }
            if (memoryData.preferences?.agentName) {
              setAgentName(memoryData.preferences.agentName);
              agentNameRef.current = memoryData.preferences.agentName;
            }
          } else {
            // Initialize memory
            const initialMemory: MechanicMemory = {
              userId: user.uid,
              preferences: {
                mechanicName: orderState.mechanicName,
                shopName: orderState.shopName,
                language: selectedLanguage,
                agentName: ''
              },
              learnedFacts: [],
              recentHistory: [],
              updatedAt: serverTimestamp()
            };
            await setDoc(memoryRef, initialMemory);
            setMechanicMemory(initialMemory);
          }
        } catch (error) {
          console.error("Error fetching mechanic memory:", error);
          handleFirestoreError(error, OperationType.GET, `mechanic_memory/${user.uid}`);
        }
      } else {
        setMechanicMemory(null);
      }
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!deviceId || !user) return;

    // Fetch latest draft order for this device and user
    const path = 'orders';
    const q = query(
      collection(db, path),
      where('userId', '==', user.uid),
      where('deviceId', '==', deviceId),
      where('status', '==', 'draft'),
      orderBy('updatedAt', 'desc'),
      limit(1)
    );

    const unsubscribeOrders = onSnapshot(q, (snapshot) => {
      if (!snapshot.empty) {
        const doc = snapshot.docs[0];
        const data = doc.data() as OrderState;
        
        resolveDraftSafeMedia(data.media || []).then((resolvedMedia) => {
          const fullyResolved = { ...data, media: resolvedMedia, id: doc.id };
          // Only update if we don't have an active unsaved session or if it's the same order
          setOrderState(prev => {
            if (!prev.id || prev.id === doc.id) {
              if (fullyResolved.status === 'confirmed' || fullyResolved.isConfirmed) {
                return prev;
              }
              return fullyResolved;
            }
            return prev;
          });
        });
      }
    }, (error) => {
      // If it's a permission error, it might be because the user is not logged in yet
      const msg = error?.message?.toLowerCase() || '';
      if (msg.includes('insufficient') || msg.includes('permission') || error?.code === 'permission-denied') {
        console.warn("Draft fetch waiting for auth or rules deploy (non-fatal)...");
      } else if (msg.includes('index') || error?.code === 'failed-precondition') {
        console.warn("Draft query requires index, falling back safely (non-fatal).");
      } else {
        handleFirestoreError(error, OperationType.LIST, path);
      }
    });

    return () => unsubscribeOrders();
  }, [deviceId, user]);

  if (authLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-6 text-center">
        <div className="bg-white p-10 rounded-3xl shadow-2xl max-w-md w-full border border-gray-100">
          <h1 className="text-3xl font-bold text-gray-900 mb-2 tracking-tight flex items-baseline justify-center gap-2">
            {agentName || 'Ria'}
            <span className="text-sm font-normal text-gray-500">The Future of Parts Intake, Available Today</span>
          </h1>
          <p className="text-gray-500 mb-8 max-w-xs mx-auto">Connecting to your shop assistant...</p>
          <div className="flex justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#5B89B1]"></div>
          </div>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-6 text-center">
        <div className="bg-white p-10 rounded-3xl shadow-2xl max-w-md w-full border border-gray-100">
          <h1 className="text-3xl font-bold text-gray-900 mb-2 tracking-tight flex items-baseline justify-center gap-2">
            {agentName || 'Ria'}
            <span className="text-sm font-normal text-gray-500">The Future of Parts Intake, Available Today</span>
          </h1>
          <p className="text-gray-500 mb-8 max-w-xs mx-auto">Your intelligent shop assistant. Please sign in to continue.</p>
          <button 
            onClick={loginWithGoogle}
            className="w-full py-4 bg-[#5B89B1] text-white font-bold rounded-2xl hover:bg-[#4A7194] transition-all shadow-lg active:scale-95 flex items-center justify-center gap-3"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
              <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
              <path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" />
              <path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
            </svg>
            Sign in with Google
          </button>
        </div>
      </div>
    );
  }

  if (appMode === 'counter') {
    return (
      <ErrorBoundary>
        <CounterDesktop 
          currentUser={user} 
          onBackToMechanic={() => {
            setAppMode('mechanic');
            window.history.pushState(null, '', '/');
          }} 
        />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <AnimatePresence>
        {/* Media Viewer Modal */}
        <AnimatePresence>
          {selectedMedia && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelectedMedia(null)}
              className="fixed inset-0 z-[60] flex flex-col items-center justify-center p-4 bg-black/95 backdrop-blur-md"
            >
              <motion.div 
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                className="relative max-w-4xl w-full flex-1 flex flex-col items-center justify-center bg-black/40 rounded-2xl overflow-hidden shadow-2xl p-2"
                onClick={(e) => e.stopPropagation()}
              >
                {/* Top Action Header Bar */}
                <div className="absolute top-4 left-4 right-4 z-10 flex items-center justify-between pointer-events-none">
                  {/* Filename/Details info tag */}
                  <div className="bg-black/60 backdrop-blur-sm px-4 py-2 rounded-xl border border-white/5 text-[11px] font-mono text-gray-300 font-bold uppercase tracking-wider flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                    {selectedMedia.type === 'photo' ? 'Photo Asset' : 'Video Record'}
                  </div>
                  
                  {/* Action controls */}
                  <div className="flex items-center gap-2 pointer-events-auto">
                    <button 
                      onClick={() => handleDownloadMedia(selectedMedia)}
                      className="h-10 px-4 bg-white/10 hover:bg-white/20 active:bg-white/30 text-white rounded-xl flex items-center justify-center gap-2 text-xs font-bold uppercase tracking-widest border border-white/10 transition-all active:scale-95 shadow-lg cursor-pointer"
                      title="Download Asset"
                    >
                      <Download size={16} />
                      <span className="hidden sm:inline">Download</span>
                    </button>
                    <button 
                      onClick={() => handleDeleteMedia(selectedMedia.id)}
                      className="h-10 px-4 bg-red-600/90 hover:bg-red-700 active:bg-red-800 text-white rounded-xl flex items-center justify-center gap-2 text-xs font-bold uppercase tracking-widest transition-all active:scale-95 shadow-lg cursor-pointer"
                      title="Delete Asset"
                    >
                      <Trash2 size={16} />
                      <span className="hidden sm:inline">Delete</span>
                    </button>
                    <button 
                      onClick={() => setSelectedMedia(null)}
                      className="w-10 h-10 bg-white/10 hover:bg-white/20 active:bg-white/30 text-white rounded-xl flex items-center justify-center border border-white/10 transition-all active:scale-95 cursor-pointer"
                      title="Close Preview"
                    >
                      <X size={20} />
                    </button>
                  </div>
                </div>

                {/* Media frame */}
                <div className="w-full flex-1 flex items-center justify-center mt-12 mb-2">
                  {selectedMedia.type === 'photo' ? (
                    <img 
                      src={selectedMedia.url} 
                      alt="Captured Preview" 
                      className="max-h-[75vh] w-auto max-w-full rounded-lg object-contain shadow-2xl border border-white/5"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div className="w-full max-h-[75vh] flex items-center justify-center bg-gray-950/60 rounded-xl overflow-hidden border border-white/5 shadow-2xl aspect-video max-w-3xl">
                      <video 
                        src={selectedMedia.url} 
                        controls 
                        autoPlay 
                        className="w-full h-full"
                      />
                    </div>
                  )}
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {orderState.status === 'confirmed' && (
          <motion.div 
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/60 backdrop-blur-sm"
          >
            <div className="w-full max-w-sm p-8 text-center bg-white shadow-2xl rounded-3xl border border-emerald-100">
              <div className="flex items-center justify-center w-20 h-20 mx-auto mb-6 bg-emerald-100 rounded-full">
                <Check className="w-10 h-10 text-emerald-600" />
              </div>
              <h2 className="mb-2 text-2xl font-bold text-gray-900">Order Confirmed!</h2>
              <p className="mb-8 text-gray-600 italic">"Lav e, gortse verchatsav!"</p>
              <button 
                onClick={() => setOrderState({ ...INITIAL_STATE, status: 'draft' })}
                className="w-full py-4 font-semibold text-white transition-all bg-emerald-600 rounded-2xl hover:bg-emerald-700 active:scale-95"
              >
                Start New Order
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="h-screen w-screen bg-[#FDFDFD] text-gray-800 flex flex-col overflow-hidden font-sans relative">
        {/* Header with Logout */}
        <header className="h-12 border-b border-gray-100 flex items-center justify-between px-4 bg-white z-40">
          <div className="flex items-center gap-2">
            <div className="flex items-baseline gap-2">
              <span className="font-bold text-[28px] tracking-tight">{agentName || 'Ria'}</span>
              <span className="text-xs text-gray-400 font-normal hidden sm:inline">The Future of Parts Intake, Available Today</span>
            </div>
            
            {/* Draft status indicator */}
            <AnimatePresence>
              {draftStatus && (
                <motion.div
                  initial={{ opacity: 0, y: -10, scale: 0.9 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -10, scale: 0.9 }}
                  className={`ml-4 px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider flex items-center gap-1.5 shadow-sm border ${
                    draftStatus === 'saved' 
                      ? 'bg-green-50 text-green-600 border-green-200/50' 
                      : 'bg-blue-50 text-blue-600 border-blue-200/50'
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${draftStatus === 'saved' ? 'bg-green-500 animate-pulse' : 'bg-blue-500 animate-pulse'}`} />
                  {draftStatus === 'saved' ? 'Draft Saved' : 'Draft Recovered'}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          
          <div className="flex items-center gap-4">
            <button
              onClick={() => {
                setAppMode('counter');
                window.history.pushState(null, '', '/counter');
              }}
              className="px-3 py-1.5 border border-[#5B89B1]/30 hover:border-[#5B89B1] text-[#5B89B1] hover:bg-blue-50 text-[10px] font-bold uppercase tracking-wider rounded-lg transition-all shadow-sm shrink-0"
            >
              Parts Counter Desk
            </button>
            {!process.env.GEMINI_API_KEY && window.aistudio && (
              <button 
                onClick={handleSelectKey}
                className={`text-[10px] font-bold uppercase tracking-widest transition-colors border rounded-full px-3 py-1 flex items-center gap-1 ${
                  hasApiKey ? 'text-green-500 border-green-500/20' : 'text-red-500 border-red-500/20'
                }`}
              >
                <div className={`w-1.5 h-1.5 rounded-full ${hasApiKey ? 'bg-green-500' : 'bg-red-500'}`} />
                {hasApiKey ? 'Key Active' : 'Key Missing'}
              </button>
            )}
            {!isFirebaseReady && (
              <div className="flex items-center gap-1 text-red-500 text-[10px] font-bold uppercase tracking-wider">
                <AlertCircle size={12} />
                Offline
              </div>
            )}
            <div className="flex items-center gap-2">
              {user ? (
                user.isAnonymous ? (
                  <button 
                    onClick={loginWithGoogle}
                    className="px-3 py-1.5 bg-[#5B89B1] text-white text-[10px] font-bold uppercase tracking-wider rounded-lg hover:bg-[#4A7194] transition-all shadow-sm"
                  >
                    Sync with Google
                  </button>
                ) : (
                  <>
                    <span className="text-xs text-gray-500 hidden sm:inline">{user.email}</span>
                    <button 
                      onClick={handleLogout}
                      className="text-[10px] font-bold uppercase tracking-widest text-gray-400 hover:text-red-500 transition-colors"
                    >
                      Logout
                    </button>
                  </>
                )
              ) : (
                <div className="w-4 h-4 border-2 border-[#5B89B1] border-t-transparent rounded-full animate-spin" />
              )}
            </div>
          </div>
        </header>

        {/* Desktop Layout */}
        <main className="hidden md:flex flex-1 overflow-hidden">
          {/* Left Column: Conversation */}
          <div className="w-80 lg:w-96 h-full border-r border-gray-100 bg-white shrink-0">
            <Conversation messages={messages} language={selectedLanguage} agentName={agentName} />
          </div>

          {/* Center Column: Input */}
          <div className="flex-1 h-full bg-[#FDFDFD] overflow-hidden">
            <AudioVisualizer 
              isListening={isListening} 
              isConnecting={isConnecting}
              isSpeaking={isSpeaking} 
              onToggleMic={toggleMic} 
              selectedLanguage={selectedLanguage}
              onLanguageChange={handleLanguageChange}
              media={orderState.media}
              onCapture={handleCapture}
              isConfirmed={orderState.isConfirmed}
              onToggleConfirm={handleToggleConfirm}
              onSubmit={handleSubmitOrder}
              onSave={handleSaveOrder}
              onReset={handleResetOrder}
              onFeedback={handleFeedback}
              onHelp={() => setIsHelpOpen(true)}
              onPay={handlePayOrder}
              onSendText={handleSendText}
              transcription={transcription}
              hasApiKey={hasApiKey}
              onSelectKey={handleSelectKey}
              onSelectMedia={setSelectedMedia}
              vehicle={orderState.vehicle}
              vehicleIdentityLock={orderState.vehicleIdentityLock}
              plateState={orderState.plateState || 'CA'}
              onPlateStateChange={(s) => handleUpdateState({ plateState: s })}
              onUpdateVehicle={(v) => handleUpdateState({ vehicle: v })}
              onUpdateState={handleUpdateState}
            />
          </div>

          {/* Right Column: Order Summary */}
          <div className="w-80 lg:w-96 h-full border-l border-gray-100 bg-white shrink-0">
            <OrderSummary 
              user={user}
              state={orderState} 
              onSubmit={handleSubmitOrder} 
              onSave={handleSaveOrder}
              onReset={handleResetOrder} 
              onLoadOrder={handleLoadOrder}
              onToggleConfirm={handleToggleConfirm}
              language={selectedLanguage}
              inMemoryOrders={completedOrders}
              historyOrders={historyOrders}
              onSelectMedia={setSelectedMedia}
            />
          </div>
        </main>

        {/* Mobile Layout */}
        <main className="flex md:hidden flex-1 flex-col overflow-hidden">
          <div className="flex-1 overflow-hidden relative">
            <div className={`absolute inset-0 transition-transform duration-300 ${activeTab === 'conversation' ? 'translate-x-0' : '-translate-x-full'}`}>
              <Conversation messages={messages} language={selectedLanguage} agentName={agentName} />
            </div>
            <div className={`absolute inset-0 transition-transform duration-300 ${activeTab === 'input' ? 'translate-x-0' : (activeTab === 'conversation' ? 'translate-x-full' : '-translate-x-full')}`}>
              <AudioVisualizer 
                isListening={isListening} 
                isSpeaking={isSpeaking} 
                onToggleMic={toggleMic} 
                selectedLanguage={selectedLanguage}
                onLanguageChange={handleLanguageChange}
                media={orderState.media}
                onCapture={handleCapture}
                isConfirmed={orderState.isConfirmed}
                onToggleConfirm={handleToggleConfirm}
                onSubmit={handleSubmitOrder}
                onSave={() => setShowSaveOptions(true)}
                onReset={handleResetOrder}
                onFeedback={handleFeedback}
                onHelp={() => setIsHelpOpen(true)}
                onPay={handlePayOrder}
                onSendText={handleSendText}
                transcription={transcription}
                hasApiKey={hasApiKey}
                onSelectKey={handleSelectKey}
                onSelectMedia={setSelectedMedia}
                vehicle={orderState.vehicle}
                vehicleIdentityLock={orderState.vehicleIdentityLock}
                plateState={orderState.plateState || 'CA'}
                onPlateStateChange={(s) => handleUpdateState({ plateState: s })}
                onUpdateVehicle={(v) => handleUpdateState({ vehicle: v })}
                onUpdateState={handleUpdateState}
              />
            </div>
            <div className={`absolute inset-0 transition-transform duration-300 ${activeTab === 'summary' ? 'translate-x-0' : 'translate-x-full'}`}>
              <OrderSummary 
                user={user}
                state={orderState} 
                onSubmit={handleSubmitOrder} 
                onSave={() => setShowSaveOptions(true)}
                onReset={handleResetOrder} 
                onLoadOrder={handleLoadOrder}
                onToggleConfirm={handleToggleConfirm}
                language={selectedLanguage}
                inMemoryOrders={completedOrders}
                historyOrders={historyOrders}
                onSelectMedia={setSelectedMedia}
              />
            </div>
          </div>

          {/* Mobile Navigation Bar */}
          <nav className="h-24 bg-white border-t border-gray-100 flex items-center justify-around px-4 shadow-lg z-40">
            <button 
              onClick={() => setActiveTab('conversation')}
              className={`flex flex-col items-center gap-1 transition-colors ${activeTab === 'conversation' ? 'text-[#5B89B1]' : 'text-gray-400'}`}
            >
              <div className={`w-1 h-1 rounded-full mb-1 ${activeTab === 'conversation' ? 'bg-[#5B89B1]' : 'bg-transparent'}`} />
              <span className="text-[20px] font-bold uppercase tracking-widest">Chat</span>
            </button>
            <button 
              onClick={() => setActiveTab('input')}
              className={`flex flex-col items-center gap-1 transition-colors ${activeTab === 'input' ? 'text-[#5B89B1]' : 'text-gray-400'}`}
            >
              <div className={`w-1 h-1 rounded-full mb-1 ${activeTab === 'input' ? 'bg-[#5B89B1]' : 'bg-transparent'}`} />
              <span className="text-[20px] font-bold uppercase tracking-widest mt-1">{agentName || 'Ria'}</span>
            </button>
            <button 
              onClick={() => setActiveTab('summary')}
              className={`flex flex-col items-center gap-1 transition-colors ${activeTab === 'summary' ? 'text-[#5B89B1]' : 'text-gray-400'}`}
            >
              <div className={`w-1 h-1 rounded-full mb-1 ${activeTab === 'summary' ? 'bg-[#5B89B1]' : 'bg-transparent'}`} />
              <span className="text-[20px] font-bold uppercase tracking-widest">Order</span>
            </button>
          </nav>
        </main>

      {/* Mechanic Video Call Modal */}
      {orderState.id && orderState.videoCall?.status === 'calling' && appMode === 'mechanic' && (
        <MechanicCallModal
          orderId={orderState.id}
          videoCall={orderState.videoCall}
          onClose={() => {
            const orderRef = doc(db, 'orders', orderState.id!);
            updateDoc(orderRef, {
              videoCall: {
                status: 'ended',
                updatedAt: Date.now()
              }
            }).catch(err => console.error("Failed to update call end status:", err));
          }}
        />
      )}

      {/* Camera Modal */}
      {cameraMode && (
        <CameraModal 
          mode={cameraMode} 
          onCapture={onCameraCapture} 
          onClose={() => setCameraMode(null)} 
        />
      )}

      {/* Payment Modal */}
      {showPaymentModal && (
        <PaymentModal 
          onClose={() => setShowPaymentModal(false)}
          onSuccess={handleProcessPayment}
          totalAmount={0} // total calculation could be added
          initialMethod={selectedPaymentMethod}
          language={selectedLanguage}
        />
      )}

      {/* Save Options Modal */}
      <AnimatePresence>
        {showSaveOptions && (
          <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="w-full max-w-xs bg-white rounded-3xl p-6 shadow-2xl"
            >
              <h3 className="text-lg font-bold text-gray-900 mb-6 text-center">Save Invoice Format</h3>
              <div className="space-y-3">
                <button 
                  onClick={() => handleSaveToPhone('pdf')}
                  className="w-full py-4 bg-[#5B89B1] text-white rounded-2xl font-bold flex items-center justify-center gap-3 hover:bg-[#4A7194] transition-all"
                >
                  <FileText size={20} />
                  <span>Save as PDF</span>
                </button>
                <button 
                  onClick={() => handleSaveToPhone('text')}
                  className="w-full py-4 bg-gray-100 text-gray-700 rounded-2xl font-bold flex items-center justify-center gap-3 hover:bg-gray-200 transition-all"
                >
                  <Download size={20} />
                  <span>Save as Text</span>
                </button>
                <button 
                  onClick={() => setShowSaveOptions(false)}
                  className="w-full py-3 text-gray-400 font-bold text-sm uppercase tracking-widest"
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Help Agent Modal */}
      <HelpAgent 
        isOpen={isHelpOpen} 
        onClose={() => setIsHelpOpen(false)} 
        isMainListening={isListening}
        language={selectedLanguage}
        agentName={agentName}
      />

      {/* Feedback Modal */}
      <FeedbackModal
        isOpen={isFeedbackOpen}
        onClose={() => setIsFeedbackOpen(false)}
        onSubmit={handleSubmitFeedback}
        userEmail={user?.email}
        userId={user?.uid}
        deviceId={deviceId}
        language={selectedLanguage}
        agentName={agentName}
      />
      </div>
    </ErrorBoundary>
  );
};

export default App;
