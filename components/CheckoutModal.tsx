
import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { KickflipEvent } from '../types';

interface CheckoutModalProps {
  event: KickflipEvent;
  onClose: () => void;
  onSuccess: (quantity: number) => void;
  accentColor?: string;
}

type CheckoutStep = 'review' | 'payment' | 'processing' | 'confirmation';

export const CheckoutModal: React.FC<CheckoutModalProps> = ({ event, onClose, onSuccess, accentColor = '#34d399' }) => {
  const [step, setStep] = useState<CheckoutStep>('review');
  const [quantity, setQuantity] = useState(1);
  const [cardNumber, setCardNumber] = useState('');
  const [expiry, setExpiry] = useState('');
  const [cvc, setCvc] = useState('');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = 'auto'; };
  }, []);
  
  // Safe Price Parsing
  const getPrice = (priceStr?: string) => {
      if (!priceStr) return 0;
      const lower = priceStr.toLowerCase();
      if (lower.includes('free') || lower.includes('no cover')) return 0;
      const numeric = priceStr.replace(/[^0-9.]/g, '');
      return parseFloat(numeric) || 0;
  };

  const basePrice = getPrice(event.price);
  
  const fee = basePrice > 0 ? 2.50 : 0;
  const total = (basePrice + fee) * quantity;

  // Format currency
  const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  const handlePayment = () => {
    setStep('processing');
    // Simulate API call
    setTimeout(() => {
        setStep('confirmation');
    }, 2000);
  };

  const handleFinalize = () => {
      onSuccess(quantity);
      onClose();
  };

  if (!mounted || typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/90 backdrop-blur-md transition-opacity duration-300"
        onClick={onClose}
      />

      {/* Modal Container */}
      <div className="relative w-full max-w-md bg-[#111] border border-white/10 rounded-3xl overflow-hidden shadow-2xl transition-all duration-300 transform">
        
        {/* Header Image (Mini) */}
        <div className="h-24 w-full bg-gray-900 relative">
            {event.videoUrl ? (
                <video src={event.videoUrl} className="w-full h-full object-cover opacity-60" autoPlay muted loop playsInline />
            ) : (
                <img src={event.imageUrl || "https://images.pexels.com/photos/1105666/pexels-photo-1105666.jpeg"} className="w-full h-full object-cover opacity-60" alt={event.title} />
            )}
            <div className="absolute inset-0 bg-gradient-to-b from-transparent to-[#111]" />
            <button 
                onClick={onClose} 
                className="absolute top-4 right-4 p-2 bg-black/50 hover:bg-white hover:text-black rounded-full text-white transition-all backdrop-blur-md z-10"
            >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
        </div>

        <div className="p-8 pt-2">
            
            {/* --- STEP 1: REVIEW --- */}
            {step === 'review' && (
                <div className="space-y-6">
                    <div>
                        <h2 className="text-2xl font-black text-white leading-tight mb-1">{event.title}</h2>
                        <p className="text-white/50 text-sm font-medium">{event.date} • {event.location}</p>
                    </div>

                    <div className="bg-white/5 rounded-2xl p-4 border border-white/5 space-y-4">
                        <div className="flex justify-between items-center">
                            <span className="text-sm font-bold text-white/70">General Admission</span>
                            <div className="flex items-center gap-3 bg-black/40 rounded-lg p-1 border border-white/10">
                                <button 
                                    onClick={() => setQuantity(Math.max(1, quantity - 1))}
                                    className="w-8 h-8 flex items-center justify-center text-white/50 hover:text-white transition-colors"
                                >
                                    -
                                </button>
                                <span className="font-mono font-bold w-4 text-center text-white">{quantity}</span>
                                <button 
                                    onClick={() => setQuantity(Math.min(10, quantity + 1))}
                                    className="w-8 h-8 flex items-center justify-center text-white/50 hover:text-white transition-colors"
                                >
                                    +
                                </button>
                            </div>
                        </div>
                    </div>

                    <div className="space-y-2 py-4 border-t border-b border-white/10">
                        <div className="flex justify-between text-sm">
                            <span className="text-white/50">Ticket Price</span>
                            <span className="font-mono text-white/80">{basePrice > 0 ? fmt(basePrice) : 'Free'}</span>
                        </div>
                        {basePrice > 0 && (
                            <div className="flex justify-between text-sm">
                                <span className="text-white/50">Service Fee</span>
                                <span className="font-mono text-white/80">{fmt(fee)}</span>
                            </div>
                        )}
                        <div className="flex justify-between text-lg font-black pt-2 text-white">
                            <span>Total</span>
                            <span>{basePrice > 0 ? fmt(total) : 'Free'}</span>
                        </div>
                    </div>

                    <button 
                        onClick={() => setStep('payment')}
                        className="w-full py-4 rounded-xl font-black text-black text-sm uppercase tracking-widest hover:scale-[1.02] active:scale-[0.98] transition-all shadow-lg"
                        style={{ backgroundColor: accentColor }}
                    >
                        {basePrice > 0 ? 'Proceed to Payment' : 'Complete RSVP'}
                    </button>
                </div>
            )}

            {/* --- STEP 2: PAYMENT --- */}
            {step === 'payment' && (
                <div className="space-y-6">
                    <div className="flex items-center gap-4 mb-2">
                        <button onClick={() => setStep('review')} className="text-white/50 hover:text-white">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
                        </button>
                        <h3 className="text-xl font-black uppercase tracking-wide text-white">Payment Method</h3>
                    </div>

                    <div className="space-y-4">
                        <div className="bg-white/5 border border-white/10 rounded-xl p-4 flex items-center gap-4 opacity-50 cursor-not-allowed">
                            <div className="w-8 h-5 bg-white rounded flex items-center justify-center"><span className="text-[8px] text-black font-bold">PAY</span></div>
                            <span className="font-bold text-sm text-white">Apple Pay</span>
                        </div>
                        
                        <div className="space-y-3">
                            <div>
                                <label className="text-[10px] font-bold uppercase tracking-widest text-white/40 mb-2 block">Card Number</label>
                                <input 
                                    type="text" 
                                    placeholder="0000 0000 0000 0000"
                                    value={cardNumber}
                                    onChange={(e) => {
                                        const v = e.target.value.replace(/\D/g, '').slice(0, 16);
                                        setCardNumber(v.replace(/(.{4})/g, '$1 ').trim());
                                    }}
                                    className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 font-mono text-white focus:outline-none focus:border-white/40 transition-colors"
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="text-[10px] font-bold uppercase tracking-widest text-white/40 mb-2 block">Expiry</label>
                                    <input 
                                        type="text" 
                                        placeholder="MM/YY" 
                                        value={expiry}
                                        onChange={(e) => {
                                            let v = e.target.value.replace(/\D/g, '').slice(0, 4);
                                            if (v.length >= 2) v = v.slice(0, 2) + '/' + v.slice(2);
                                            setExpiry(v);
                                        }}
                                        className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 font-mono text-white focus:outline-none focus:border-white/40 transition-colors"
                                    />
                                </div>
                                <div>
                                    <label className="text-[10px] font-bold uppercase tracking-widest text-white/40 mb-2 block">CVC</label>
                                    <input 
                                        type="text" 
                                        placeholder="123" 
                                        value={cvc}
                                        onChange={(e) => setCvc(e.target.value.replace(/\D/g, '').slice(0, 3))}
                                        className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 font-mono text-white focus:outline-none focus:border-white/40 transition-colors"
                                    />
                                </div>
                            </div>
                        </div>
                    </div>

                    <button 
                        onClick={handlePayment}
                        disabled={cardNumber.replace(/\s/g, '').length < 16}
                        className="w-full py-4 rounded-xl font-black text-black text-sm uppercase tracking-widest hover:scale-[1.02] active:scale-[0.98] transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed mt-4"
                        style={{ backgroundColor: accentColor }}
                    >
                        Pay {basePrice > 0 ? fmt(total) : 'Securely'}
                    </button>
                </div>
            )}

            {/* --- STEP 3: PROCESSING --- */}
            {step === 'processing' && (
                <div className="flex flex-col items-center justify-center py-12 space-y-6">
                    <div className="relative w-16 h-16">
                        <div className="absolute inset-0 rounded-full border-4 border-white/10"></div>
                        <div className="absolute inset-0 rounded-full border-4 border-t-transparent animate-spin" style={{ borderColor: `${accentColor} transparent transparent transparent` }}></div>
                    </div>
                    <p className="text-sm font-bold uppercase tracking-widest animate-pulse text-white/70">Securing Tickets...</p>
                </div>
            )}

            {/* --- STEP 4: CONFIRMATION --- */}
            {step === 'confirmation' && (
                <div className="flex flex-col items-center justify-center space-y-6 text-center">
                    <div className="w-20 h-20 bg-green-500 rounded-full flex items-center justify-center shadow-[0_0_30px_rgba(34,197,94,0.4)] mb-2">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="4"><polyline points="20 6 9 17 4 12"></polyline></svg>
                    </div>
                    
                    <div>
                        <h2 className="text-3xl font-black uppercase tracking-tighter text-white mb-2">You're In!</h2>
                        <p className="text-white/60 text-sm max-w-[200px] mx-auto">Your tickets have been sent to your email.</p>
                    </div>

                    <div className="w-full bg-white/5 border-2 border-dashed border-white/10 rounded-xl p-4 flex items-center justify-between">
                        <div className="text-left">
                            <p className="text-[10px] font-bold uppercase tracking-widest text-white/30">Event</p>
                            <p className="font-bold text-white text-sm truncate max-w-[150px]">{event.title}</p>
                        </div>
                        <div className="text-right">
                            <p className="text-[10px] font-bold uppercase tracking-widest text-white/30">Qty</p>
                            <p className="font-bold text-white text-sm">x{quantity}</p>
                        </div>
                    </div>

                    <button 
                        onClick={handleFinalize}
                        className="w-full py-4 rounded-xl font-black text-black text-sm uppercase tracking-widest hover:scale-[1.02] active:scale-[0.98] transition-all bg-white shadow-xl"
                    >
                        Done
                    </button>
                </div>
            )}

        </div>
      </div>
    </div>,
    document.body
  );
};
