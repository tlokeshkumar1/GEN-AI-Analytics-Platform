import React from 'react';
import logoImg from '../assets/logo-transparent.png';

interface NeovaticLogoProps {
  className?: string;
  size?: number;
  showText?: boolean;
}

export const NeovaticLogo: React.FC<NeovaticLogoProps> = ({
  className = '',
  size = 38,
  showText = true,
}) => {
  return (
    <div className={`flex items-center gap-2.5 sm:gap-3 select-none ${className}`}>
      {/* Brand Mark: Official Neovatic Logo */}
      <div
        className="relative shrink-0 flex items-center justify-center overflow-hidden"
        style={{ height: `${size}px` }}
      >
        <img
          src={logoImg}
          alt="Neovatic Logo"
          className="h-full w-auto object-contain drop-shadow-2xs"
          style={{ height: `${size}px` }}
        />
      </div>

      {showText && (
        <div className="flex flex-col text-left min-6-0 justify-center">
          <span className="font-headline-sm text-[15px] sm:text-[16px] leading-tight tracking-tight text-[#0F172A] font-bold truncate">
            NEOVATIC
          </span>
          <span className="font-headline-sm text-[15px] sm:text-[16px] leading-tight tracking-tight text-[#0F172A] font-bold truncate">
            AI ANALYTICS
          </span>
        </div>
      )}
    </div>
  );
};
