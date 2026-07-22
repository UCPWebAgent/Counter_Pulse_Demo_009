import React, { useState, useEffect, useRef } from 'react';
import { db, auth, OperationType, handleFirestoreError } from '../lib/firebase';
import { collection, onSnapshot, query, doc, updateDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { OrderState, MediaItem, PartOrder, FluidOrder } from '../types';
import { 
  Car, Wrench, Clock, AlertTriangle, PhoneCall, Video, CheckCircle, 
  Plus, Send, X, ArrowLeft, Shield, Check, Loader2, Download, RefreshCw
} from 'lucide-react';

interface CounterDesktopProps {
  onBackToMechanic: () => void;
  currentUser: any;
}

export const CounterDesktop: React.FC<CounterDesktopProps> = ({ onBackToMechanic, currentUser }) => {
  const [orders, setOrders] = useState<OrderState[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<OrderState | null>(null);
  const [loading, setLoading] = useState(true);
  const [newNote, setNewNote] = useState('');
  const [roleUpdated, setRoleUpdated] = useState(false);
  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);
  const [lightboxMedia, setLightboxMedia] = useState<MediaItem | null>(null);

  // WebRTC Video Call State
  const [callActive, setCallActive] = useState(false);
  const [callStatus, setCallStatus] = useState<'idle' | 'calling' | 'connected' | 'ended'>('idle');
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);

  // Ensure current user is synced as 'admin' in Firestore so they can read and write all orders
  useEffect(() => {
    if (currentUser && !roleUpdated) {
      const ensureAdminRole = async () => {
        try {
          const userRef = doc(db, 'users', currentUser.uid);
          await setDoc(userRef, {
            uid: currentUser.uid,
            email: currentUser.email,
            displayName: currentUser.displayName,
            photoURL: currentUser.photoURL,
            role: 'admin',
            updatedAt: serverTimestamp()
          }, { merge: true });
          setRoleUpdated(true);
          console.log("Successfully ensured admin role for counter app user:", currentUser.uid);
        } catch (err) {
          console.error("Failed to set admin role in Firestore:", err);
        }
      };
      ensureAdminRole();
    }
  }, [currentUser, roleUpdated]);

  // Subscribe to ALL orders in the system
  useEffect(() => {
    const ordersRef = collection(db, 'orders');
    const q = query(ordersRef);

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const fetched = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as OrderState[];

      // Sort in memory by updatedAt descending
      const sorted = fetched.sort((a, b) => {
        const timeA = a.updatedAt?.toMillis?.() || a.updatedAt || 0;
        const timeB = b.updatedAt?.toMillis?.() || b.updatedAt || 0;
        return timeB - timeA;
      });

      setOrders(sorted);
      setLoading(false);

      // Keep active selected order updated with live server values
      if (selectedOrder) {
        const updatedSelected = sorted.find(o => o.id === selectedOrder.id);
        if (updatedSelected) {
          setSelectedOrder(updatedSelected);
          
          // Detect call acceptance or hangup
          if (callActive) {
            const call = updatedSelected.videoCall;
            if (call) {
              if (call.status === 'answered' && callStatus === 'calling') {
                setCallStatus('connected');
                handleAnswerReceived(call.answer);
              } else if (call.status === 'ended' && (callStatus === 'calling' || callStatus === 'connected')) {
                endCallSession(false);
              }
            } else if (callStatus !== 'idle') {
              endCallSession(false);
            }
          }
        }
      }
    }, (error) => {
      console.error("Error subscribing to global order list:", error);
      handleFirestoreError(error, OperationType.LIST, 'orders');
    });

    return () => unsubscribe();
  }, [selectedOrder, callActive, callStatus]);

  const updateOrderFields = async (orderId: string, fields: Partial<OrderState>) => {
    try {
      const orderRef = doc(db, 'orders', orderId);
      await updateDoc(orderRef, {
        ...fields,
        updatedAt: serverTimestamp()
      });
    } catch (err) {
      console.error("Failed to update order fields:", err);
      handleFirestoreError(err, OperationType.UPDATE, `orders/${orderId}`);
    }
  };

  const handleStatusChange = async (status: 'New' | 'Reviewing' | 'Ready' | 'Completed') => {
    if (!selectedOrder?.id) return;
    setIsUpdatingStatus(true);
    await updateOrderFields(selectedOrder.id, { counterStatus: status });
    setIsUpdatingStatus(false);
  };

  const handleRequestVIN = async () => {
    if (!selectedOrder?.id) return;
    await updateOrderFields(selectedOrder.id, { vinRequested: true });
    
    // Add an automatic note
    const systemNote = `[System] Requested VIN from mechanic.`;
    const updatedNotes = [...(selectedOrder.counterNotes || []), systemNote];
    await updateOrderFields(selectedOrder.id, { counterNotes: updatedNotes });
  };

  const handleAddNote = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!selectedOrder?.id || !newNote.trim()) return;

    const formattedNote = `${currentUser?.displayName || 'Counter Staff'}: ${newNote.trim()}`;
    const updatedNotes = [...(selectedOrder.counterNotes || []), formattedNote];
    
    await updateOrderFields(selectedOrder.id, { counterNotes: updatedNotes });
    setNewNote('');
  };

  // ===============================================================
  // WebRTC Video Call Logic
  // ===============================================================

  const startVideoCall = async () => {
    if (!selectedOrder?.id) return;

    try {
      setCallActive(true);
      setCallStatus('calling');

      // Get user camera stream
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setLocalStream(stream);
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      // Initialize peer connection
      const configuration = {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      };
      const pc = new RTCPeerConnection(configuration);
      peerConnectionRef.current = pc;

      // Add local tracks to peer connection
      stream.getTracks().forEach(track => {
        pc.addTrack(track, stream);
      });

      // Handle remote track stream arriving
      pc.ontrack = (event) => {
        if (event.streams && event.streams[0]) {
          setRemoteStream(event.streams[0]);
          if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = event.streams[0];
          }
        }
      };

      // Create WebRTC Offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Save call state to order document to trigger mobile alert
      await updateOrderFields(selectedOrder.id, {
        videoCall: {
          status: 'calling',
          callerId: currentUser.uid,
          offer: JSON.stringify(offer),
          updatedAt: Date.now()
        }
      });

      console.log("WebRTC video call initiated, offer saved to order:", selectedOrder.id);
    } catch (err) {
      console.error("Failed to start video call:", err);
      // Fallback: Enable call simulation
      setCallActive(true);
      setCallStatus('calling');
      // Set mock streams for demonstration
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }).catch(() => null);
        if (stream) {
          setLocalStream(stream);
          if (localVideoRef.current) localVideoRef.current.srcObject = stream;
        }
      } catch (e) {}
    }
  };

  const handleAnswerReceived = async (answerStr?: string) => {
    if (!answerStr || !peerConnectionRef.current) return;
    try {
      const answer = JSON.parse(answerStr);
      await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(answer));
      console.log("WebRTC peer connection answer applied successfully.");
    } catch (err) {
      console.error("Failed to set remote answer:", err);
    }
  };

  const endCallSession = async (triggerUpdate = true) => {
    setCallStatus('ended');
    setCallActive(false);

    // Stop all media tracks
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      setLocalStream(null);
    }
    setRemoteStream(null);

    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    if (triggerUpdate && selectedOrder?.id) {
      await updateOrderFields(selectedOrder.id, {
        videoCall: {
          status: 'ended',
          updatedAt: Date.now()
        }
      });
    }

    setTimeout(() => {
      setCallStatus('idle');
    }, 2000);
  };

  const getUrgencyColor = (urgency?: string) => {
    switch (urgency) {
      case 'urgent': return 'bg-red-500 text-white animate-pulse';
      case 'high': return 'bg-orange-500 text-white';
      case 'medium': return 'bg-yellow-500 text-gray-900';
      default: return 'bg-blue-100 text-[#5B89B1]';
    }
  };

  const getStatusColor = (status?: string) => {
    switch (status) {
      case 'Reviewing': return 'bg-amber-100 text-amber-800 border-amber-200';
      case 'Ready': return 'bg-green-100 text-green-800 border-green-200';
      case 'Completed': return 'bg-blue-100 text-blue-800 border-blue-200';
      default: return 'bg-rose-100 text-rose-800 border-rose-200'; // New
    }
  };

  const formatTimestamp = (timestamp: any) => {
    if (!timestamp) return 'Just now';
    try {
      const date = typeof timestamp.toDate === 'function' ? timestamp.toDate() : new Date(timestamp);
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' ' + date.toLocaleDateString();
    } catch (e) {
      return 'Recently';
    }
  };

  return (
    <div className="flex flex-col h-screen bg-[#F3F4F6] font-sans text-gray-800 antialiased overflow-hidden">
      {/* Header */}
      <header className="h-16 shrink-0 bg-white border-b border-gray-200 px-6 flex items-center justify-between shadow-sm z-10">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-gradient-to-tr from-[#5B89B1] to-[#4A7194] rounded-lg text-white shadow-md">
            <Shield size={20} />
          </div>
          <div>
            <h1 className="text-md font-bold tracking-tight text-gray-900 flex items-center gap-2">
              Parts Counter Desk <span className="text-xs px-2 py-0.5 bg-blue-100 text-[#5B89B1] rounded-full font-medium">Demonstration</span>
            </h1>
            <p className="text-[10px] text-gray-500">ABC Auto Parts Center & Live Mechanic Sync</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <span className="text-xs text-gray-500 font-mono bg-gray-100 px-3 py-1 rounded-full flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-green-500 animate-ping"></span>
            Role: Counter Specialist
          </span>
          <button
            onClick={onBackToMechanic}
            className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs font-bold rounded-xl transition-all flex items-center gap-2 shadow-sm"
          >
            <ArrowLeft size={14} />
            Mechanic Portal
          </button>
        </div>
      </header>

      {/* Main Workspace Grid */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar: Live Order Queue */}
        <aside className="w-80 lg:w-96 border-r border-gray-200 bg-white flex flex-col shrink-0">
          <div className="p-4 border-b border-gray-100 shrink-0">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-bold text-gray-900 uppercase tracking-wider flex items-center gap-2">
                Live Orders Queue
                <span className="bg-red-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full">
                  {orders.filter(o => !o.counterStatus || o.counterStatus !== 'Completed').length}
                </span>
              </h2>
              <div className="text-[10px] text-gray-400 flex items-center gap-1">
                <RefreshCw size={10} className="animate-spin" /> Live Updates
              </div>
            </div>
            <p className="text-xs text-gray-500">Orders synced in real-time from active mechanics</p>
          </div>

          <div className="flex-1 overflow-y-auto custom-scrollbar p-3 space-y-3 bg-gray-50">
            {loading ? (
              <div className="flex flex-col items-center justify-center py-12 text-gray-400 gap-2">
                <Loader2 size={24} className="animate-spin text-[#5B89B1]" />
                <span className="text-xs">Connecting to queue...</span>
              </div>
            ) : orders.length === 0 ? (
              <div className="text-center py-12 text-gray-400">
                <Car size={32} className="mx-auto mb-2 text-gray-300" />
                <p className="text-xs font-medium">No orders in queue</p>
                <p className="text-[10px] mt-1 text-gray-400">Orders created by mechanics will appear here instantly</p>
              </div>
            ) : (
              orders.map((order) => {
                const isActive = selectedOrder?.id === order.id;
                const cStatus = order.counterStatus || 'New';
                const partsCount = (order.parts?.length || 0) + (order.fluids?.length || 0);
                
                return (
                  <div
                    key={order.id}
                    onClick={() => setSelectedOrder(order)}
                    className={`p-4 rounded-2xl cursor-pointer border transition-all duration-200 ${
                      isActive 
                        ? 'bg-blue-50/50 border-blue-200 shadow-sm' 
                        : 'bg-white hover:bg-gray-50 border-gray-200 hover:border-gray-300 shadow-sm'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border ${getStatusColor(cStatus)}`}>
                          {cStatus}
                        </span>
                        {order.urgency && (
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${getUrgencyColor(order.urgency)}`}>
                            {order.urgency}
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] text-gray-400 font-mono shrink-0">
                        {formatTimestamp(order.updatedAt)}
                      </span>
                    </div>

                    <h3 className="text-sm font-bold text-gray-900 leading-snug">
                      {order.vehicle?.year || ''} {order.vehicle?.make || 'Unknown'} {order.vehicle?.model || 'Vehicle'}
                    </h3>

                    {order.vehicle?.vin && (
                      <p className="text-[11px] text-gray-500 font-mono mt-0.5">VIN: {order.vehicle.vin}</p>
                    )}

                    <div className="flex items-center gap-4 mt-3 text-xs text-gray-500 border-t border-gray-100 pt-2.5">
                      <div className="flex items-center gap-1">
                        <Wrench size={12} className="text-gray-400" />
                        <span>{partsCount} requested items</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <Clock size={12} className="text-gray-400" />
                        <span>{order.mechanicName || 'Arman'}</span>
                      </div>
                    </div>

                    {order.vinRequested && !order.vehicle?.vin && (
                      <div className="mt-2 bg-amber-50 text-amber-700 text-[10px] font-medium p-1.5 rounded-lg border border-amber-100 flex items-center gap-1.5">
                        <AlertTriangle size={12} />
                        VIN requested from mechanic
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </aside>

        {/* Main Panel */}
        <main className="flex-1 bg-[#F9FAFB] flex flex-col overflow-hidden">
          {selectedOrder ? (
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* Active Order Control Bar */}
              <div className="bg-white border-b border-gray-200 p-4 shrink-0 flex flex-wrap items-center justify-between gap-4 shadow-sm">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500 font-semibold uppercase tracking-wider font-mono">ORDER ID: {selectedOrder.id}</span>
                    <span className="text-xs text-gray-400">•</span>
                    <span className="text-xs text-gray-500 font-medium">Mechanic: {selectedOrder.mechanicName || 'Arman'} ({selectedOrder.shopName || 'ABC Auto'})</span>
                  </div>
                  <h2 className="text-lg font-bold text-gray-900 mt-0.5">
                    {selectedOrder.vehicle?.year} {selectedOrder.vehicle?.make} {selectedOrder.vehicle?.model} {selectedOrder.vehicle?.trim}
                  </h2>
                </div>

                {/* Counter Actions */}
                <div className="flex flex-wrap items-center gap-2.5">
                  {/* Status buttons */}
                  <div className="bg-gray-100 p-1 rounded-xl flex items-center gap-1">
                    {(['New', 'Reviewing', 'Ready', 'Completed'] as const).map((status) => {
                      const isCurrent = (selectedOrder.counterStatus || 'New') === status;
                      return (
                        <button
                          key={status}
                          disabled={isUpdatingStatus}
                          onClick={() => handleStatusChange(status)}
                          className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-all ${
                            isCurrent
                              ? 'bg-white text-gray-900 shadow-sm'
                              : 'text-gray-500 hover:text-gray-900'
                          }`}
                        >
                          {status}
                        </button>
                      );
                    })}
                  </div>

                  <div className="h-6 w-px bg-gray-200 mx-1"></div>

                  <button
                    onClick={handleRequestVIN}
                    disabled={!!selectedOrder.vehicle?.vin || selectedOrder.vinRequested}
                    className={`px-3 py-2 text-xs font-bold rounded-xl border flex items-center gap-1.5 transition-all ${
                      selectedOrder.vehicle?.vin 
                        ? 'bg-gray-50 text-gray-400 border-gray-100 cursor-not-allowed'
                        : selectedOrder.vinRequested
                          ? 'bg-amber-50 text-amber-700 border-amber-200'
                          : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50 hover:border-gray-400 shadow-sm'
                    }`}
                  >
                    <Plus size={14} />
                    {selectedOrder.vehicle?.vin ? 'VIN Available' : selectedOrder.vinRequested ? 'VIN Requested' : 'Request VIN'}
                  </button>

                  <button
                    onClick={startVideoCall}
                    className="px-3 py-2 bg-[#5B89B1] hover:bg-[#4A7194] text-white text-xs font-bold rounded-xl shadow-md transition-all flex items-center gap-1.5"
                  >
                    <Video size={14} />
                    Start Video Call
                  </button>
                </div>
              </div>

              {/* Order Details Grid */}
              <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-6">
                
                {/* Real-time Video Call Overlay */}
                {callActive && (
                  <div className="bg-slate-900 rounded-3xl p-6 text-white shadow-2xl relative border-2 border-[#5B89B1] overflow-hidden">
                    <div className="absolute top-4 left-4 bg-red-500 text-xs font-bold px-2.5 py-1 rounded-full animate-pulse flex items-center gap-1.5 z-20">
                      <span className="w-1.5 h-1.5 rounded-full bg-white"></span>
                      LIVE VIDEO INSPECTION
                    </div>
                    <button
                      onClick={() => endCallSession()}
                      className="absolute top-4 right-4 bg-white/10 hover:bg-red-500 hover:text-white p-2.5 rounded-full text-white transition-all z-20"
                    >
                      <X size={16} />
                    </button>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 h-96 relative">
                      {/* Left: Mechanic Stream */}
                      <div className="bg-slate-950 rounded-2xl relative overflow-hidden flex items-center justify-center border border-white/10">
                        {callStatus === 'calling' ? (
                          <div className="flex flex-col items-center gap-3 text-center p-4">
                            <Loader2 size={32} className="animate-spin text-[#5B89B1]" />
                            <h4 className="text-sm font-bold">Calling {selectedOrder.mechanicName || 'Mechanic'}...</h4>
                            <p className="text-xs text-gray-400">Waiting for response on mobile device</p>
                          </div>
                        ) : (
                          <video
                            ref={remoteVideoRef}
                            autoPlay
                            playsInline
                            className="w-full h-full object-cover"
                          />
                        )}
                        <div className="absolute bottom-3 left-3 bg-black/60 px-2.5 py-1 rounded-lg text-xs font-semibold backdrop-blur-sm">
                          🔧 {selectedOrder.mechanicName || 'Mechanic'}'s Feed
                        </div>
                      </div>

                      {/* Right: Counter Stream */}
                      <div className="bg-slate-950 rounded-2xl relative overflow-hidden flex items-center justify-center border border-white/10">
                        <video
                          ref={localVideoRef}
                          autoPlay
                          playsInline
                          muted
                          className="w-full h-full object-cover"
                        />
                        <div className="absolute bottom-3 left-3 bg-black/60 px-2.5 py-1 rounded-lg text-xs font-semibold backdrop-blur-sm">
                          🖥️ My Feed (Counter Desk)
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Requested Parts and Fluids Section */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                  
                  {/* Left Block: Parts & Fluids (8 Columns) */}
                  <div className="lg:col-span-8 space-y-6">
                    
                    {/* Vehicle Identity Card */}
                    <div className="bg-white rounded-2xl p-5 border border-gray-200 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div className="flex items-center gap-4">
                        <div className="w-12 h-12 bg-blue-50 text-[#5B89B1] rounded-xl flex items-center justify-center shrink-0">
                          <Car size={24} />
                        </div>
                        <div>
                          <span className="text-[10px] text-gray-400 uppercase tracking-widest font-mono">Vehicle Details</span>
                          <h3 className="text-md font-bold text-gray-900 leading-tight">
                            {selectedOrder.vehicle?.year ? `${selectedOrder.vehicle.year} ` : ''}
                            {selectedOrder.vehicle?.make || 'Unknown Make'} 
                            {selectedOrder.vehicle?.model ? ` ${selectedOrder.vehicle.model}` : ''}
                          </h3>
                          {selectedOrder.vehicle?.trim && (
                            <p className="text-xs text-gray-500 mt-0.5">Trim Level: {selectedOrder.vehicle.trim} • {selectedOrder.vehicle.engine}</p>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        {selectedOrder.vehicle?.vin && (
                          <div className="bg-gray-100 border border-gray-200 rounded-xl px-3 py-1.5 text-center font-mono text-xs">
                            <span className="text-[9px] text-gray-400 block tracking-wider uppercase">VIN</span>
                            <span className="font-bold text-gray-700">{selectedOrder.vehicle.vin}</span>
                          </div>
                        )}
                        {selectedOrder.vehicle?.licensePlate && (
                          <div className="bg-gray-100 border border-gray-200 rounded-xl px-3 py-1.5 text-center font-mono text-xs">
                            <span className="text-[9px] text-gray-400 block tracking-wider uppercase">PLATE</span>
                            <span className="font-bold text-gray-700">{selectedOrder.vehicle.licensePlate} ({selectedOrder.vehicle.plateState || selectedOrder.plateState || 'CA'})</span>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Requested Parts List */}
                    <div className="bg-white rounded-3xl border border-gray-200 shadow-sm overflow-hidden">
                      <div className="p-5 border-b border-gray-100 bg-gray-50/50 flex items-center justify-between">
                        <h3 className="text-sm font-bold uppercase tracking-wider text-gray-900 flex items-center gap-2">
                          <Wrench size={16} className="text-[#5B89B1]" />
                          Parts Requested
                        </h3>
                        <span className="bg-blue-100 text-[#5B89B1] text-xs font-bold px-2.5 py-1 rounded-full">
                          {selectedOrder.parts?.length || 0} Items
                        </span>
                      </div>

                      <div className="divide-y divide-gray-100">
                        {!selectedOrder.parts || selectedOrder.parts.length === 0 ? (
                          <p className="text-center py-8 text-xs text-gray-400 font-medium">No special parts requested</p>
                        ) : (
                          selectedOrder.parts.map((part: PartOrder, idx: number) => (
                            <div key={idx} className="p-5 flex items-start justify-between gap-4 hover:bg-gray-50/50 transition-colors">
                              <div className="space-y-1.5 flex-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <h4 className="text-sm font-bold text-gray-900">{part.name}</h4>
                                  {part.brand && (
                                    <span className="text-[10px] bg-gray-100 border border-gray-200 font-semibold px-2 py-0.5 rounded text-gray-600">
                                      Brand preference: {part.brand}
                                    </span>
                                  )}
                                </div>
                                {part.partNumber && (
                                  <p className="text-xs text-gray-500 font-mono">Part number matched: {part.partNumber}</p>
                                )}
                                {part.notes && (
                                  <p className="text-xs bg-yellow-50 text-yellow-800 p-2.5 rounded-xl border border-yellow-100 flex items-start gap-1.5">
                                    <AlertTriangle size={14} className="shrink-0 text-yellow-600 mt-0.5" />
                                    <span>Notes: {part.notes}</span>
                                  </p>
                                )}

                                {/* Fitment Confidence Indicator */}
                                {part.fitmentConfidence !== undefined && (
                                  <div className="flex items-center gap-2 pt-1">
                                    <span className="text-[10px] text-gray-400 font-medium uppercase tracking-wider">Fitment Confidence:</span>
                                    <div className="w-24 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                                      <div 
                                        className={`h-full rounded-full ${part.fitmentConfidence > 0.8 ? 'bg-green-500' : 'bg-amber-500'}`}
                                        style={{ width: `${part.fitmentConfidence * 100}%` }}
                                      ></div>
                                    </div>
                                    <span className={`text-[10px] font-bold ${part.fitmentConfidence > 0.8 ? 'text-green-600' : 'text-amber-600'}`}>
                                      {Math.round(part.fitmentConfidence * 100)}%
                                    </span>
                                  </div>
                                )}
                              </div>

                              <div className="flex flex-col items-end gap-1.5 shrink-0">
                                <span className="text-xs font-bold text-gray-500 bg-gray-100 px-2.5 py-1 rounded-lg">
                                  Qty: {part.quantity}
                                </span>
                                {part.urgency && (
                                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wider ${getUrgencyColor(part.urgency)}`}>
                                    {part.urgency}
                                  </span>
                                )}
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    {/* Requested Fluids List */}
                    <div className="bg-white rounded-3xl border border-gray-200 shadow-sm overflow-hidden">
                      <div className="p-5 border-b border-gray-100 bg-gray-50/50 flex items-center justify-between">
                        <h3 className="text-sm font-bold uppercase tracking-wider text-gray-900 flex items-center gap-2">
                          <Car size={16} className="text-[#5B89B1]" />
                          Fluids Requested
                        </h3>
                        <span className="bg-blue-100 text-[#5B89B1] text-xs font-bold px-2.5 py-1 rounded-full">
                          {selectedOrder.fluids?.length || 0} Fluids
                        </span>
                      </div>

                      <div className="divide-y divide-gray-100">
                        {!selectedOrder.fluids || selectedOrder.fluids.length === 0 ? (
                          <p className="text-center py-8 text-xs text-gray-400 font-medium">No fluids requested</p>
                        ) : (
                          selectedOrder.fluids.map((fluid: FluidOrder, idx: number) => (
                            <div key={idx} className="p-5 flex items-start justify-between gap-4 hover:bg-gray-50/50 transition-colors">
                              <div className="space-y-1">
                                <h4 className="text-sm font-bold text-gray-900 capitalize">
                                  {fluid.subcategory.replace('_', ' ')}
                                </h4>
                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-gray-500">
                                  <span>Specification: <strong className="text-gray-700 font-semibold">{fluid.spec}</strong></span>
                                  {fluid.brand && <span>• Brand: <strong className="text-gray-700 font-semibold">{fluid.brand}</strong></span>}
                                  {fluid.type && <span>• Type: <strong className="text-gray-700 font-semibold">{fluid.type}</strong></span>}
                                </div>
                              </div>

                              <div className="flex flex-col items-end gap-1.5 shrink-0">
                                <span className="text-xs font-bold text-[#5B89B1] bg-blue-50 px-2.5 py-1 rounded-lg">
                                  {fluid.quantity || 'As required'}
                                </span>
                                {fluid.urgency && (
                                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wider ${getUrgencyColor(fluid.urgency)}`}>
                                    {fluid.urgency}
                                  </span>
                                )}
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                  </div>

                  {/* Right Block: Media Attachments, Notes & History (4 Columns) */}
                  <div className="lg:col-span-4 space-y-6">
                    
                    {/* Media Attachments */}
                    <div className="bg-white rounded-3xl p-5 border border-gray-200 shadow-sm">
                      <h3 className="text-sm font-bold uppercase tracking-wider text-gray-900 mb-4 flex items-center gap-2">
                        <Video size={16} className="text-[#5B89B1]" />
                        Media Uploads ({selectedOrder.media?.length || 0})
                      </h3>

                      {!selectedOrder.media || selectedOrder.media.length === 0 ? (
                        <div className="text-center py-6 border border-dashed border-gray-200 rounded-2xl text-gray-400">
                          <Car size={24} className="mx-auto mb-1 text-gray-300" />
                          <p className="text-[11px]">No diagnostic media uploaded</p>
                        </div>
                      ) : (
                        <div className="grid grid-cols-2 gap-3">
                          {selectedOrder.media.map((item: MediaItem) => (
                            <div 
                              key={item.id} 
                              onClick={() => setLightboxMedia(item)}
                              className="group relative h-24 bg-gray-100 rounded-xl overflow-hidden border border-gray-200 shadow-sm cursor-pointer hover:shadow-md transition-all"
                            >
                              <img 
                                src={item.thumbnailUrl || item.url} 
                                alt={item.type} 
                                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                              />
                              <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                <span className="text-white text-[10px] font-bold uppercase tracking-wider bg-black/60 px-2 py-1 rounded-md">View</span>
                              </div>
                              <div className="absolute bottom-1 right-1 bg-black/60 px-1.5 py-0.5 rounded text-[8px] text-white font-mono uppercase">
                                {item.type}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Counter Internal Notes Section */}
                    <div className="bg-white rounded-3xl p-5 border border-gray-200 shadow-sm flex flex-col h-[400px]">
                      <h3 className="text-sm font-bold uppercase tracking-wider text-gray-900 mb-4 flex items-center gap-2 shrink-0">
                        <Clock size={16} className="text-[#5B89B1]" />
                        Parts Desk Notes
                      </h3>

                      {/* Notes scrolling history */}
                      <div className="flex-1 overflow-y-auto custom-scrollbar space-y-3 mb-4 pr-1">
                        {!selectedOrder.counterNotes || selectedOrder.counterNotes.length === 0 ? (
                          <div className="h-full flex flex-col items-center justify-center text-center text-gray-400">
                            <Clock size={20} className="mb-1 text-gray-300" />
                            <p className="text-xs">No desk notes added</p>
                            <p className="text-[10px] mt-0.5 text-gray-400">Notes are visible to counter staff and preserved on order</p>
                          </div>
                        ) : (
                          selectedOrder.counterNotes.map((note: string, idx: number) => {
                            const isSystem = note.startsWith('[System]');
                            return (
                              <div 
                                key={idx} 
                                className={`p-2.5 rounded-xl border text-xs leading-relaxed ${
                                  isSystem 
                                    ? 'bg-amber-50/55 text-amber-800 border-amber-100 font-mono text-[10px]' 
                                    : 'bg-gray-50 text-gray-700 border-gray-100'
                                }`}
                              >
                                {note}
                              </div>
                            );
                          })
                        )}
                      </div>

                      {/* Add note input form */}
                      <form onSubmit={handleAddNote} className="flex items-center gap-2 shrink-0 border-t border-gray-100 pt-3">
                        <input
                          type="text"
                          value={newNote}
                          onChange={(e) => setNewNote(e.target.value)}
                          placeholder="Add internal parts note..."
                          className="flex-1 px-3 py-2 text-xs bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:border-[#5B89B1] focus:bg-white transition-all"
                        />
                        <button
                          type="submit"
                          disabled={!newNote.trim()}
                          className="p-2 bg-[#5B89B1] text-white rounded-xl hover:bg-[#4A7194] disabled:bg-gray-100 disabled:text-gray-300 transition-colors shadow-sm shrink-0"
                        >
                          <Send size={14} />
                        </button>
                      </form>
                    </div>

                  </div>

                </div>

              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center p-12 text-center text-gray-400">
              <div className="p-6 bg-white border border-gray-100 rounded-full shadow-md mb-4 flex items-center justify-center">
                <Car size={48} className="text-[#5B89B1]/40" />
              </div>
              <h3 className="text-md font-bold text-gray-700">Select an Order to Review</h3>
              <p className="text-xs max-w-sm mt-1.5 text-gray-500 leading-relaxed">
                Click any incoming mechanic service request in the left queue to check vehicle details, parts requirements, diagnostic files, and interact live.
              </p>
            </div>
          )}
        </main>
      </div>

      {/* Media Lightbox/Viewer Modal */}
      {lightboxMedia && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/90 backdrop-blur-sm">
          <div className="relative max-w-3xl w-full flex flex-col items-center gap-4">
            <button
              onClick={() => setLightboxMedia(null)}
              className="absolute -top-12 right-0 bg-white/10 hover:bg-white/20 text-white p-2.5 rounded-full transition-all"
            >
              <X size={20} />
            </button>
            <div className="bg-slate-950 rounded-2xl overflow-hidden border border-white/15 shadow-2xl max-h-[70vh] flex items-center justify-center">
              {lightboxMedia.type === 'video' ? (
                <video 
                  src={lightboxMedia.url} 
                  controls 
                  autoPlay 
                  className="max-h-[70vh] object-contain"
                />
              ) : (
                <img 
                  src={lightboxMedia.url} 
                  alt="Diagnostic Attachment" 
                  className="max-h-[70vh] object-contain"
                />
              )}
            </div>
            <div className="text-white text-xs font-medium font-mono px-3 py-1 bg-black/40 rounded-full backdrop-blur-sm flex items-center gap-2">
              <span>Media Attachment ID: {lightboxMedia.id}</span>
              <span>•</span>
              <a 
                href={lightboxMedia.url} 
                download={`diagnostic_${lightboxMedia.id}.${lightboxMedia.type === 'photo' ? 'png' : 'webm'}`}
                className="hover:text-blue-400 transition-colors flex items-center gap-1"
              >
                <Download size={12} /> Download
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
