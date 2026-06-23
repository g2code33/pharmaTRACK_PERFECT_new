// PharmTrack - Onboarding Page

import React, { useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useApp } from '../context/AppContext';
import { Student } from '../types';
import { GraduationCap, User, Building, BookOpen, Calendar, ArrowRight, Sparkles } from 'lucide-react';

const Onboarding: React.FC = () => {
  const { dispatch } = useApp();
  const [step, setStep] = useState(1);
  const [formData, setFormData] = useState({
    name: '',
    university: 'University of Cape Coast',
    level: 'Level 200',
    program: 'Doctor of Pharmacy (Pharm.D)',
    semester: '1st Semester',
  });

  const levels = ['Level 100', 'Level 200', 'Level 300', 'Level 400', 'Level 500', 'Level 600'];
  const semesters = ['1st Semester', '2nd Semester'];
  const programs = [
    'Doctor of Pharmacy (Pharm.D)',
    'Bachelor of Pharmacy (B.Pharm)',
    'Pharmaceutical Sciences',
  ];

  const handleSubmit = () => {
    const student: Student = {
      id: uuidv4(),
      name: formData.name,
      university: formData.university,
      level: formData.level,
      program: formData.program,
      semester: formData.semester,
      createdAt: new Date().toISOString(),
    };
    dispatch({ type: 'SET_STUDENT', payload: student });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#1B4332] via-[#2D6A4F] to-[#40916C] flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        {/* Logo and intro */}
        <div className="text-center mb-8">
          <div className="w-48 h-48 mb-6 mx-auto drop-shadow-[0_0_20px_rgba(74,222,128,0.3)] animate-pulse-slow">
  <img src="/logo.png" alt="PharmaTRACK" className="w-full h-full object-contain" />
</div>
<h1 className="text-4xl font-black text-white tracking-tighter mb-2 italic uppercase">
  Pharma<span className="text-[#4ADE80]">TRACK</span>
</h1>
          <p className="text-gray-200">Your personalized pharmacy study companion</p>
        </div>

        {/* Form card */}
        <div className="bg-white rounded-2xl shadow-2xl p-6 md:p-8">
          {step === 1 ? (
            <>
              <div className="flex items-center gap-2 mb-6">
                <Sparkles className="w-5 h-5 text-[#FFB703]" />
                <h2 className="text-xl font-semibold text-gray-800">Let's set up your account</h2>
              </div>

              <div className="space-y-4">
                {/* Name */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Your Name
                  </label>
                  <div className="relative">
                    <User className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                    <input
                      type="text"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      placeholder="Enter your full name"
                      className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] focus:border-transparent outline-none transition-all"
                    />
                  </div>
                </div>

                {/* University */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    University
                  </label>
                  <div className="relative">
                    <Building className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                    <input
                      type="text"
                      value={formData.university}
                      onChange={(e) => setFormData({ ...formData, university: e.target.value })}
                      placeholder="University name"
                      className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] focus:border-transparent outline-none transition-all"
                    />
                  </div>
                </div>

                {/* Program */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Program
                  </label>
                  <div className="relative">
                    <BookOpen className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                    <select
                      value={formData.program}
                      onChange={(e) => setFormData({ ...formData, program: e.target.value })}
                      className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] focus:border-transparent outline-none transition-all appearance-none bg-white"
                    >
                      {programs.map((p) => (
                        <option key={p} value={p}>{p}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <button
                  onClick={() => setStep(2)}
                  disabled={!formData.name.trim()}
                  className="w-full mt-4 py-3 bg-[#2D6A4F] text-white font-semibold rounded-lg hover:bg-[#1B4332] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  Continue
                  <ArrowRight className="w-5 h-5" />
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 mb-6">
                <Calendar className="w-5 h-5 text-[#FFB703]" />
                <h2 className="text-xl font-semibold text-gray-800">Academic Details</h2>
              </div>

              <div className="space-y-4">
                {/* Level */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Current Level
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {levels.map((level) => (
                      <button
                        key={level}
                        onClick={() => setFormData({ ...formData, level })}
                        className={`py-2 px-3 text-sm rounded-lg border-2 transition-all ${
                          formData.level === level
                            ? 'border-[#2D6A4F] bg-[#2D6A4F]/10 text-[#2D6A4F] font-semibold'
                            : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        {level}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Semester */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Current Semester
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    {semesters.map((sem) => (
                      <button
                        key={sem}
                        onClick={() => setFormData({ ...formData, semester: sem })}
                        className={`py-3 px-4 rounded-lg border-2 transition-all ${
                          formData.semester === sem
                            ? 'border-[#2D6A4F] bg-[#2D6A4F]/10 text-[#2D6A4F] font-semibold'
                            : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        {sem}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex gap-3 mt-6">
                  <button
                    onClick={() => setStep(1)}
                    className="flex-1 py-3 border border-gray-300 text-gray-700 font-semibold rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    Back
                  </button>
                  <button
                    onClick={handleSubmit}
                    className="flex-1 py-3 bg-[#FFB703] text-[#1B4332] font-semibold rounded-lg hover:bg-[#FFA500] transition-colors flex items-center justify-center gap-2"
                  >
                    Get Started
                    <Sparkles className="w-5 h-5" />
                  </button>
                </div>
              </div>
            </>
          )}

          {/* Progress indicator */}
          <div className="flex justify-center gap-2 mt-6">
            <div className={`w-2 h-2 rounded-full ${step === 1 ? 'bg-[#2D6A4F]' : 'bg-gray-300'}`} />
            <div className={`w-2 h-2 rounded-full ${step === 2 ? 'bg-[#2D6A4F]' : 'bg-gray-300'}`} />
          </div>
        </div>

        {/* Features preview */}
        <div className="mt-8 grid grid-cols-3 gap-4 text-center">
          <div className="text-white/80">
            <div className="w-10 h-10 bg-white/10 rounded-lg flex items-center justify-center mx-auto mb-2">
              <BookOpen className="w-5 h-5" />
            </div>
            <p className="text-xs">Organize Courses</p>
          </div>
          <div className="text-white/80">
            <div className="w-10 h-10 bg-white/10 rounded-lg flex items-center justify-center mx-auto mb-2">
              <FileQuestion className="w-5 h-5" />
            </div>
            <p className="text-xs">Generate Questions</p>
          </div>
          <div className="text-white/80">
            <div className="w-10 h-10 bg-white/10 rounded-lg flex items-center justify-center mx-auto mb-2">
              <BarChart3 className="w-5 h-5" />
            </div>
            <p className="text-xs">Track Progress</p>
          </div>
        </div>
      </div>
    </div>
  );
};

// Import icons used in the preview
import { FileQuestion, BarChart3 } from 'lucide-react';

export default Onboarding;
