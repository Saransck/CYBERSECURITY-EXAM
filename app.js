// ============================================================
// CYBERSECURITY EXAM & PRETEST APP CONTROLLER
// High-performance, fully client-side cybersecurity exam engine
// ============================================================

(function() {
  // Application State
  const state = {
    section: 'pretest', // 'pretest' | 'exam' | 'lab' | 'mock'
    mode: 'practice',   // 'practice' | 'exam' | 'flashcard'
    language: 'both',   // 'both' | 'th' | 'en' (pretest only)
    currentIndex: 0,
    questions: [],
    userAnswers: {},     // { [id]: answerIndex or string }
    practiceChecked: {}, // { [id]: boolean }
    flagged: new Set(),
    isSubmitted: false,
    timerSeconds: 90 * 60, // 90 minutes
    timerInterval: null,
    soundEnabled: true,
    flashcardFlipped: false,
    filterReview: 'all', // 'all' | 'wrong' | 'flagged'
    examStartTime: null,
    timeSpentSeconds: 0
  };

  // Web Audio API Sound Synthesizer (Zero external dependencies)
  const AudioEngine = {
    ctx: null,
    init() {
      if (!this.ctx && (window.AudioContext || window.webkitAudioContext)) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AudioContext();
      }
    },
    unlock() {
      this.init();
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume();
      }
    },
    play(type) {
      if (!state.soundEnabled) return;
      try {
        this.unlock();
        if (!this.ctx) return;
        
        const now = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.connect(gain);
        gain.connect(this.ctx.destination);

        if (type === 'click') {
          osc.type = 'sine';
          osc.frequency.setValueAtTime(600, now);
          osc.frequency.exponentialRampToValueAtTime(300, now + 0.05);
          gain.gain.setValueAtTime(0.08, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
          osc.start(now);
          osc.stop(now + 0.05);
        } else if (type === 'correct') {
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(523.25, now); // C5
          osc.frequency.setValueAtTime(659.25, now + 0.08); // E5
          osc.frequency.setValueAtTime(783.99, now + 0.16); // G5
          gain.gain.setValueAtTime(0.12, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
          osc.start(now);
          osc.stop(now + 0.35);
        } else if (type === 'wrong') {
          osc.type = 'sawtooth';
          osc.frequency.setValueAtTime(220, now);
          osc.frequency.setValueAtTime(180, now + 0.1);
          gain.gain.setValueAtTime(0.1, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
          osc.start(now);
          osc.stop(now + 0.25);
        } else if (type === 'complete') {
          // 4-note victory chime
          const notes = [523.25, 659.25, 783.99, 1046.50];
          notes.forEach((freq, idx) => {
            const o = this.ctx.createOscillator();
            const g = this.ctx.createGain();
            o.type = 'sine';
            o.frequency.setValueAtTime(freq, now + idx * 0.1);
            g.gain.setValueAtTime(0.12, now + idx * 0.1);
            g.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.1 + 0.3);
            o.connect(g);
            g.connect(this.ctx.destination);
            o.start(now + idx * 0.1);
            o.stop(now + idx * 0.1 + 0.3);
          });
        }
      } catch (e) {
        // Audio error silent fallback
      }
    }
  };

  // Helper Functions
  function normalizeText(text) {
    if (typeof text !== 'string') return '';
    return text.trim().toLowerCase().replace(/[\s\-_'"`|]/g, '');
  }

  function isAnswerCorrect(question, answer) {
    if (answer === undefined || answer === null || answer === '') return false;
    
    // Multiple choice numeric index match
    const hasOpts = (Array.isArray(question.options) && question.options.length > 0) ||
                    (Array.isArray(question.options_th) && question.options_th.length > 0);
    if (hasOpts && typeof question.answer === 'number') {
      if (Number(answer) === Number(question.answer)) return true;
    }
    
    // Text fill-in matching (or matching text of choices/accepted_texts)
    const normUser = normalizeText(String(answer));
    if (question.accepted_texts && Array.isArray(question.accepted_texts) && question.accepted_texts.length > 0) {
      if (question.accepted_texts.some(acc => normalizeText(acc) === normUser)) return true;
    }

    if (question.answer_display) {
      if (normalizeText(question.answer_display) === normUser) return true;
    }

    if (question.answer !== undefined && question.answer !== null) {
      if (normalizeText(String(question.answer)) === normUser) return true;
    }

    // Also check if text matches the correct option text itself
    if (hasOpts && typeof question.answer === 'number') {
      const opts = question.options_th || question.options;
      if (opts && opts[question.answer] && normalizeText(opts[question.answer]) === normUser) {
        return true;
      }
    }

    return false;
  }

  function getActiveQuestions() {
    if (state.section === 'pretest') {
      return QUESTION_BANK.pretest;
    } else if (state.section === 'exam') {
      return QUESTION_BANK.exam;
    } else if (state.section === 'lab') {
      return QUESTION_BANK.lab;
    } else if (state.section === 'ncsa') {
      return QUESTION_BANK.ncsa || [];
    } else if (state.section === 'mock') {
      return [
        ...QUESTION_BANK.pretest,
        ...QUESTION_BANK.exam,
        ...QUESTION_BANK.lab,
        ...(QUESTION_BANK.ncsa || [])
      ];
    }
    return QUESTION_BANK.pretest;
  }

  // DOM Elements cache
  let dom = {};

  function initDOM() {
    dom = {
      sectionTabs: document.querySelectorAll('.tab-btn'),
      modeChips: document.querySelectorAll('.mode-chip'),
      langToggleGroup: document.getElementById('langToggleGroup'),
      langBtns: document.querySelectorAll('.lang-btn'),
      soundToggleBtn: document.getElementById('soundToggleBtn'),
      resetBtn: document.getElementById('resetBtn'),
      
      // Main workspace areas
      examView: document.getElementById('examView'),
      flashcardView: document.getElementById('flashcardView'),
      
      // Exam View elements
      qCounter: document.getElementById('qCounter'),
      qCategoryTag: document.getElementById('qCategoryTag'),
      timerBox: document.getElementById('timerBox'),
      timerDisplay: document.getElementById('timerDisplay'),
      progressFill: document.getElementById('progressFill'),
      
      questionCard: document.getElementById('questionCard'),
      questionTextTh: document.getElementById('questionTextTh'),
      questionTextEn: document.getElementById('questionTextEn'),
      codeSnippetContainer: document.getElementById('codeSnippetContainer'),
      optionsList: document.getElementById('optionsList'),
      fillContainer: document.getElementById('fillContainer'),
      fillInput: document.getElementById('fillInput'),
      fillSubmitBtn: document.getElementById('fillSubmitBtn'),
      explanationCard: document.getElementById('explanationCard'),
      expText: document.getElementById('expText'),
      
      // Bottom navigation
      prevBtn: document.getElementById('prevBtn'),
      nextBtn: document.getElementById('nextBtn'),
      flagBtn: document.getElementById('flagBtn'),
      submitExamBtn: document.getElementById('submitExamBtn'),
      
      // Matrix & Sidebar
      questionGrid: document.getElementById('questionGrid'),
      answeredCountSpan: document.getElementById('answeredCountSpan'),
      totalCountSpan: document.getElementById('totalCountSpan'),
      
      // Flashcard elements
      card3d: document.getElementById('card3d'),
      cardCategory: document.getElementById('cardCategory'),
      cardLangTag: document.getElementById('cardLangTag'),
      cardFrontText: document.getElementById('cardFrontText'),
      cardBackAnswer: document.getElementById('cardBackAnswer'),
      cardBackExp: document.getElementById('cardBackExp'),
      fcPrevBtn: document.getElementById('fcPrevBtn'),
      fcFlipBtn: document.getElementById('fcFlipBtn'),
      fcNextBtn: document.getElementById('fcNextBtn'),
      fcCounter: document.getElementById('fcCounter'),
      
      // Modal score
      scoreModal: document.getElementById('scoreModal'),
      scoreRank: document.getElementById('scoreRank'),
      scoreRankSub: document.getElementById('scoreRankSub'),
      scoreTotalText: document.getElementById('scoreTotalText'),
      scorePercentText: document.getElementById('scorePercentText'),
      scoreTimeText: document.getElementById('scoreTimeText'),
      catBreakdownList: document.getElementById('catBreakdownList'),
      scoreRetakeBtn: document.getElementById('scoreRetakeBtn'),
      scoreReviewMistakesBtn: document.getElementById('scoreReviewMistakesBtn'),
      scoreCloseBtn: document.getElementById('scoreCloseBtn')
    };
  }

  // Timer Management
  function startTimer() {
    clearInterval(state.timerInterval);
    state.examStartTime = Date.now();
    
    if (state.mode === 'exam') {
      dom.timerBox.style.display = 'flex';
      updateTimerDisplay();
      state.timerInterval = setInterval(() => {
        state.timerSeconds--;
        state.timeSpentSeconds++;
        updateTimerDisplay();
        
        if (state.timerSeconds <= 0) {
          clearInterval(state.timerInterval);
          alert('หมดเวลาการสอบ! ระบบจะทำการตรวจคำตอบโดยอัตโนมัติ');
          submitExam();
        }
      }, 1000);
    } else {
      dom.timerBox.style.display = 'none';
      state.timerInterval = setInterval(() => {
        state.timeSpentSeconds++;
      }, 1000);
    }
  }

  function updateTimerDisplay() {
    if (!dom.timerDisplay) return;
    const mins = Math.floor(state.timerSeconds / 60);
    const secs = state.timerSeconds % 60;
    dom.timerDisplay.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    
    if (state.timerSeconds <= 300) { // under 5 mins
      dom.timerBox.classList.add('urgent');
    } else {
      dom.timerBox.classList.remove('urgent');
    }
  }

  // Load / Switch Section
  function switchSection(sectionName) {
    state.section = sectionName;
    state.questions = getActiveQuestions();
    state.currentIndex = 0;
    state.userAnswers = {};
    state.practiceChecked = {};
    state.flagged.clear();
    state.isSubmitted = false;
    state.timeSpentSeconds = 0;
    state.timerSeconds = state.questions.length * 150; // 2.5 mins per question
    
    // Update Tab UI
    dom.sectionTabs.forEach(tab => {
      tab.classList.toggle('active', tab.dataset.section === sectionName);
    });

    // Language switch visibility (Pretest has English & Thai bilingual toggle)
    if (sectionName === 'pretest' || (sectionName === 'mock')) {
      dom.langToggleGroup.style.display = 'flex';
    } else {
      dom.langToggleGroup.style.display = 'none';
    }

    startTimer();
    renderAll();
  }

  // Load / Switch Mode
  function switchMode(modeName) {
    state.mode = modeName;
    dom.modeChips.forEach(chip => {
      chip.classList.toggle('active', chip.dataset.mode === modeName);
    });

    if (modeName === 'flashcard') {
      dom.examView.style.display = 'none';
      dom.flashcardView.style.display = 'flex';
      renderFlashcard();
    } else {
      dom.examView.style.display = 'flex';
      dom.flashcardView.style.display = 'none';
      startTimer();
      renderQuestion();
      renderMatrix();
    }
  }

  // Render Current Question
  function renderQuestion() {
    const q = state.questions[state.currentIndex];
    if (!q) return;

    // Meta bar
    dom.qCounter.textContent = `ข้อที่ ${state.currentIndex + 1} / ${state.questions.length}`;
    dom.qCategoryTag.textContent = q.chapter ? `${q.chapter} • ${q.labName || q.category}` : (q.category || 'Cybersecurity');
    
    const pct = ((state.currentIndex + 1) / state.questions.length) * 100;
    dom.progressFill.style.width = `${pct}%`;

    // Flag button state
    if (state.flagged.has(q.id)) {
      dom.flagBtn.classList.add('active');
      dom.flagBtn.innerHTML = `<span>⭐ ปักหมุดแล้ว</span>`;
    } else {
      dom.flagBtn.classList.remove('active');
      dom.flagBtn.innerHTML = `<span>☆ ปักหมุดทบทวน</span>`;
    }

    // Question Text (Bilingual support for Pretest)
    const isPretest = state.section === 'pretest' || (q.question_en && q.question_th);
    
    if (isPretest) {
      if (state.language === 'th') {
        dom.questionTextTh.textContent = q.question_th || q.question;
        dom.questionTextTh.style.display = 'block';
        dom.questionTextEn.style.display = 'none';
      } else if (state.language === 'en') {
        dom.questionTextTh.textContent = q.question_en || q.question;
        dom.questionTextTh.style.display = 'block';
        dom.questionTextEn.style.display = 'none';
      } else {
        // Both
        dom.questionTextTh.textContent = q.question_th || q.question;
        dom.questionTextTh.style.display = 'block';
        dom.questionTextEn.textContent = q.question_en || '';
        dom.questionTextEn.style.display = q.question_en ? 'block' : 'none';
      }
    } else {
      dom.questionTextTh.textContent = q.question;
      dom.questionTextTh.style.display = 'block';
      dom.questionTextEn.style.display = 'none';
    }

    // Code / Source Link / File attachment box
    const qText = (q.question || q.question_th || q.question_en || '');
    const hasSnippet = q.source_link || q.fileUrl || qText.includes('chmod') || qText.includes('ps -ef') || qText.includes('Gur synt');
    if (hasSnippet) {
      dom.codeSnippetContainer.style.display = 'block';
      let snippetContent = '';
      if (q.fileUrl) {
        const fileName = q.fileUrl.split('/').pop() || 'download-file';
        snippetContent += `<div style="margin-bottom: 8px;">📎 <strong>ไฟล์ประกอบโจทย์ / ดาวน์โหลดแลป:</strong> <a href="${q.fileUrl}" target="_blank" rel="noopener noreferrer" style="color: var(--accent-cyan); text-decoration: underline; font-weight: 600; word-break: break-all;">${fileName}</a></div>`;
      }
      if (q.source_link) {
        snippetContent += `<div style="margin-bottom: 8px;">🔗 <strong>ลิงก์โจทย์:</strong> <a href="${q.source_link}" target="_blank" rel="noopener noreferrer" style="color: var(--accent-cyan); text-decoration: underline; word-break: break-all;">${q.source_link}</a></div>`;
      }
      if (q.id === 'lab_3') snippetContent += `<pre>Ciphertext: Gur synt vf pelcgb{E0g13_pn3fne_picu3e}\nHint: ROT13 Caesar Cipher</pre>`;
      else if (q.id === 'lab_6') snippetContent += `<pre>MD5 Hash: B963C57010F21BEDC2CC3C229B5E4D0F\nHint: md5 crack</pre>`;
      else if (q.id === 'lab_4') snippetContent += `<pre>Processes:\nroot  1  ...  /bin/bash /start.sh\nroot  8  ...  python3 /opt/app/site/manage.py\nroot 151 ...  /bin/bash (webshell)</pre>`;
      else if (q.id === 'ex_18') snippetContent += `<pre>Command:\nchmod u+s target.txt</pre>`;
      dom.codeSnippetContainer.innerHTML = snippetContent;
    } else {
      dom.codeSnippetContainer.style.display = 'none';
    }

    // Determine type: Multiple Choice vs Fill-in
    const hasOptions = (Array.isArray(q.options) && q.options.length > 0) ||
                       (Array.isArray(q.options_th) && q.options_th.length > 0) ||
                       (Array.isArray(q.options_en) && q.options_en.length > 0);
    
    if (hasOptions) {
      dom.optionsList.style.display = 'flex';
      dom.fillContainer.style.display = 'none';
      renderOptions(q);
    } else {
      dom.optionsList.style.display = 'none';
      dom.fillContainer.style.display = 'flex';
      renderFillIn(q);
    }

    // Explanation visibility
    renderExplanation(q);

    // Prev / Next button state
    dom.prevBtn.disabled = state.currentIndex === 0;
    dom.nextBtn.disabled = state.currentIndex === state.questions.length - 1;
    dom.submitExamBtn.style.display = (state.mode === 'exam' || state.currentIndex === state.questions.length - 1) ? 'inline-flex' : 'none';
  }

  // Render Multiple Choice Options
  function renderOptions(q) {
    dom.optionsList.innerHTML = '';
    const letters = ['A', 'B', 'C', 'D', 'E'];
    
    let options = [];
    if (state.section === 'pretest' || (q.options_th && q.options_en)) {
      if (state.language === 'en') {
        options = q.options_en.map((opt, i) => ({ main: opt, sub: '' }));
      } else if (state.language === 'th') {
        options = q.options_th.map((opt, i) => ({ main: opt, sub: '' }));
      } else {
        options = q.options_th.map((opt, i) => ({ main: opt, sub: q.options_en[i] }));
      }
    } else if (q.options && q.options.length > 0) {
      options = q.options.map(opt => ({ main: opt, sub: '' }));
    }

    const currentAnswer = state.userAnswers[q.id];
    const isPracticeChecked = state.mode === 'practice' && state.practiceChecked[q.id];
    const isExamSubmitted = state.mode === 'exam' && state.isSubmitted;

    options.forEach((opt, idx) => {
      const item = document.createElement('div');
      item.className = 'option-item';
      
      const isSelected = currentAnswer !== undefined && Number(currentAnswer) === idx;
      if (isSelected) item.classList.add('selected');

      // State colors for Practice mode or after Exam submission
      if (isPracticeChecked || isExamSubmitted) {
        if (idx === q.answer) {
          item.classList.add('state-correct');
        } else if (isSelected && idx !== q.answer) {
          item.classList.add('state-wrong');
        }
      }

      item.innerHTML = `
        <div class="option-key">${letters[idx] || (idx + 1)}</div>
        <div class="option-content">
          <div>${opt.main}</div>
          ${opt.sub ? `<div class="option-en-sub">${opt.sub}</div>` : ''}
        </div>
      `;

      item.addEventListener('click', () => {
        if (state.isSubmitted && state.mode === 'exam') return;
        selectOption(q, idx);
      });

      dom.optionsList.appendChild(item);
    });
  }

  // Handle Option Selection
  function selectOption(q, optionIndex) {
    state.userAnswers[q.id] = optionIndex;
    AudioEngine.play('click');

    if (state.mode === 'practice') {
      state.practiceChecked[q.id] = true;
      const isCorrect = optionIndex === q.answer;
      AudioEngine.play(isCorrect ? 'correct' : 'wrong');
    }

    renderQuestion();
    renderMatrix();
  }

  // Render Fill-in Input
  function renderFillIn(q) {
    const currentVal = state.userAnswers[q.id] || '';
    dom.fillInput.value = currentVal;
    
    const isPracticeChecked = state.mode === 'practice' && state.practiceChecked[q.id];
    const isExamSubmitted = state.mode === 'exam' && state.isSubmitted;

    if (isPracticeChecked || isExamSubmitted) {
      const correct = isAnswerCorrect(q, currentVal);
      dom.fillInput.style.borderColor = correct ? 'var(--accent-emerald)' : 'var(--accent-red)';
      dom.fillInput.style.boxShadow = correct ? 'var(--shadow-green)' : 'var(--shadow-red)';
    } else {
      dom.fillInput.style.borderColor = 'var(--border-subtle)';
      dom.fillInput.style.boxShadow = 'none';
    }

    // Dynamic button label
    if (state.mode === 'exam') {
      dom.fillSubmitBtn.textContent = '💾 บันทึกคำตอบ';
    } else {
      dom.fillSubmitBtn.textContent = '⚡ ตรวจสอบคำตอบ';
    }

    // Real-time input persistence on typing
    dom.fillInput.oninput = () => {
      const val = dom.fillInput.value;
      if (val.trim()) {
        state.userAnswers[q.id] = val.trim();
      } else {
        delete state.userAnswers[q.id];
      }
      renderMatrix();
    };

    dom.fillSubmitBtn.onclick = () => {
      const val = dom.fillInput.value.trim();
      if (!val) return;
      state.userAnswers[q.id] = val;
      state.practiceChecked[q.id] = true;
      
      const correct = isAnswerCorrect(q, val);
      AudioEngine.play(correct ? 'correct' : 'wrong');
      
      renderQuestion();
      renderMatrix();
    };

    dom.fillInput.onkeydown = (e) => {
      if (e.key === 'Enter') {
        dom.fillSubmitBtn.click();
      }
    };
  }

  // Render Explanation
  function renderExplanation(q) {
    const showExp = (state.mode === 'practice' && state.practiceChecked[q.id]) || 
                    (state.mode === 'exam' && state.isSubmitted);

    if (showExp && q.explanation) {
      dom.explanationCard.style.display = 'block';
      let correctDisplay = '';
      
      const hasOpts = (Array.isArray(q.options) && q.options.length > 0) ||
                      (Array.isArray(q.options_th) && q.options_th.length > 0);
      if (hasOpts && typeof q.answer === 'number' && q.answer >= 0) {
        const letters = ['A', 'B', 'C', 'D', 'E'];
        const opts = q.options_th || q.options;
        const ansText = opts[q.answer] || '';
        correctDisplay = `<strong>คำตอบที่ถูกต้อง: ข้อ ${letters[q.answer] || (q.answer + 1)} - ${ansText}</strong><br><br>`;
      } else if (q.answer_display) {
        correctDisplay = `<strong>คำตอบที่ถูกต้อง: ${q.answer_display}</strong><br><br>`;
      } else if (q.accepted_texts && q.accepted_texts.length > 0) {
        correctDisplay = `<strong>คำตอบที่ถูกต้อง: ${q.accepted_texts[0]}</strong><br><br>`;
      } else if (q.answer !== undefined && q.answer !== null) {
        correctDisplay = `<strong>คำตอบที่ถูกต้อง: ${q.answer}</strong><br><br>`;
      }

      dom.expText.innerHTML = `${correctDisplay}${q.explanation}`;
    } else {
      dom.explanationCard.style.display = 'none';
    }
  }

  // Render Sidebar Question Grid Matrix
  function renderMatrix() {
    dom.questionGrid.innerHTML = '';
    const total = state.questions.length;
    let answered = 0;

    state.questions.forEach((q, idx) => {
      const btn = document.createElement('button');
      btn.className = 'grid-btn';
      btn.textContent = idx + 1;

      const isCurrent = idx === state.currentIndex;
      const hasAnswer = state.userAnswers[q.id] !== undefined && state.userAnswers[q.id] !== '';
      const isFlagged = state.flagged.has(q.id);

      if (hasAnswer) answered++;
      if (isCurrent) btn.classList.add('current');
      if (hasAnswer) btn.classList.add('answered');
      if (isFlagged) btn.classList.add('flagged');

      // In practice mode or submitted exam, show correct/wrong color
      if ((state.mode === 'practice' && state.practiceChecked[q.id]) || (state.mode === 'exam' && state.isSubmitted)) {
        const correct = isAnswerCorrect(q, state.userAnswers[q.id]);
        if (correct) {
          btn.classList.add('state-correct');
        } else if (hasAnswer) {
          btn.classList.add('state-wrong');
        }
      }

      btn.addEventListener('click', () => {
        AudioEngine.play('click');
        state.currentIndex = idx;
        renderQuestion();
        renderMatrix();
      });

      dom.questionGrid.appendChild(btn);
    });

    dom.answeredCountSpan.textContent = answered;
    dom.totalCountSpan.textContent = total;
  }

  // Flashcard View Rendering
  function renderFlashcard() {
    const q = state.questions[state.currentIndex];
    if (!q) return;

    state.flashcardFlipped = false;
    dom.card3d.classList.remove('flipped');

    dom.fcCounter.textContent = `${state.currentIndex + 1} / ${state.questions.length}`;
    dom.cardCategory.textContent = q.category || 'Cybersecurity';
    
    // Front side (Question)
    const isPretest = state.section === 'pretest' || (q.question_en && q.question_th);
    if (isPretest && state.language === 'en') {
      dom.cardFrontText.textContent = q.question_en || q.question;
      dom.cardLangTag.textContent = 'EN';
    } else {
      dom.cardFrontText.textContent = q.question_th || q.question;
      dom.cardLangTag.textContent = isPretest ? 'TH / EN' : 'TH';
    }

    // Back side (Answer + Explanation)
    let ansText = '';
    const hasOpts = (Array.isArray(q.options) && q.options.length > 0) ||
                    (Array.isArray(q.options_th) && q.options_th.length > 0);
    if (hasOpts && typeof q.answer === 'number' && q.answer >= 0) {
      const letters = ['A', 'B', 'C', 'D', 'E'];
      const opts = q.options_th || q.options;
      const text = opts[q.answer] || '';
      ansText = `${letters[q.answer] || (q.answer + 1)}: ${text}`;
    } else if (q.answer_display) {
      ansText = q.answer_display;
    } else if (q.accepted_texts && q.accepted_texts.length > 0) {
      ansText = q.accepted_texts[0];
    } else if (q.answer !== undefined && q.answer !== null) {
      ansText = String(q.answer);
    }

    dom.cardBackAnswer.textContent = ansText;
    dom.cardBackExp.textContent = q.explanation || '';

    dom.fcPrevBtn.disabled = state.currentIndex === 0;
    dom.fcNextBtn.disabled = state.currentIndex === state.questions.length - 1;
  }

  function flipFlashcard() {
    state.flashcardFlipped = !state.flashcardFlipped;
    AudioEngine.play('click');
    dom.card3d.classList.toggle('flipped', state.flashcardFlipped);
  }

  // Submit Exam & Show Score Card
  function submitExam() {
    clearInterval(state.timerInterval);
    state.isSubmitted = true;
    AudioEngine.play('complete');

    let correctCount = 0;
    const catStats = {};

    state.questions.forEach(q => {
      const cat = q.category || 'General';
      if (!catStats[cat]) catStats[cat] = { correct: 0, total: 0 };
      catStats[cat].total++;

      const isCorrect = isAnswerCorrect(q, state.userAnswers[q.id]);
      if (isCorrect) {
        correctCount++;
        catStats[cat].correct++;
      }
    });

    const total = state.questions.length;
    const percentage = Math.round((correctCount / total) * 100);

    // Rank Tier
    let rank = 'C';
    let rankTitle = 'Cybersecurity Apprentice';
    if (percentage >= 90) {
      rank = 'S';
      rankTitle = 'Cybersecurity Master / Elite Pentester';
    } else if (percentage >= 80) {
      rank = 'A';
      rankTitle = 'Senior Security Analyst';
    } else if (percentage >= 70) {
      rank = 'B';
      rankTitle = 'Security Practitioner';
    } else if (percentage >= 50) {
      rank = 'C';
      rankTitle = 'Junior Defender (Needs Practice)';
    } else {
      rank = 'F';
      rankTitle = 'System Compromised (Review Topics)';
    }

    dom.scoreRank.textContent = rank;
    dom.scoreRankSub.textContent = rankTitle;
    dom.scoreTotalText.textContent = `${correctCount} / ${total}`;
    dom.scorePercentText.textContent = `${percentage}%`;
    
    const minutes = Math.floor(state.timeSpentSeconds / 60);
    const seconds = state.timeSpentSeconds % 60;
    dom.scoreTimeText.textContent = `${minutes}m ${seconds}s`;

    // Category Breakdown Bars
    dom.catBreakdownList.innerHTML = '';
    Object.keys(catStats).forEach(cat => {
      const stat = catStats[cat];
      const p = Math.round((stat.correct / stat.total) * 100);
      const div = document.createElement('div');
      div.className = 'cat-bar-item';
      div.innerHTML = `
        <div class="cat-bar-label">
          <span>${cat}</span>
          <span>${stat.correct}/${stat.total} (${p}%)</span>
        </div>
        <div class="cat-track">
          <div class="cat-fill" style="width: ${p}%"></div>
        </div>
      `;
      dom.catBreakdownList.appendChild(div);
    });

    dom.scoreModal.style.display = 'flex';
    renderQuestion();
    renderMatrix();
  }

  // Setup Event Handlers
  function setupEvents() {
    // Section Tabs
    dom.sectionTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        AudioEngine.play('click');
        switchSection(tab.dataset.section);
      });
    });

    // Mode Switcher
    dom.modeChips.forEach(chip => {
      chip.addEventListener('click', () => {
        AudioEngine.play('click');
        switchMode(chip.dataset.mode);
      });
    });

    // Language Toggle (Pretest)
    dom.langBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        dom.langBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.language = btn.dataset.lang;
        AudioEngine.play('click');
        if (state.mode === 'flashcard') {
          renderFlashcard();
        } else {
          renderQuestion();
        }
      });
    });

    // Sound Toggle
    dom.soundToggleBtn.addEventListener('click', () => {
      state.soundEnabled = !state.soundEnabled;
      dom.soundToggleBtn.classList.toggle('active', state.soundEnabled);
      dom.soundToggleBtn.innerHTML = state.soundEnabled ? '🔊 เสียงเปิด' : '🔇 เสียงปิด';
      AudioEngine.play('click');
    });

    // Reset All Answers
    dom.resetBtn.addEventListener('click', () => {
      if (confirm('คุณต้องการรีเซ็ตคำตอบทั้งหมดในชุดข้อสอบนี้ใช่หรือไม่?')) {
        state.userAnswers = {};
        state.practiceChecked = {};
        state.flagged.clear();
        state.isSubmitted = false;
        state.currentIndex = 0;
        startTimer();
        renderAll();
      }
    });

    // Previous / Next Question
    dom.prevBtn.addEventListener('click', () => {
      if (state.currentIndex > 0) {
        state.currentIndex--;
        AudioEngine.play('click');
        renderQuestion();
        renderMatrix();
      }
    });

    dom.nextBtn.addEventListener('click', () => {
      if (state.currentIndex < state.questions.length - 1) {
        state.currentIndex++;
        AudioEngine.play('click');
        renderQuestion();
        renderMatrix();
      }
    });

    // Flag Question
    dom.flagBtn.addEventListener('click', () => {
      const q = state.questions[state.currentIndex];
      if (!q) return;
      if (state.flagged.has(q.id)) {
        state.flagged.delete(q.id);
      } else {
        state.flagged.add(q.id);
      }
      AudioEngine.play('click');
      renderQuestion();
      renderMatrix();
    });

    // Submit Exam Button
    dom.submitExamBtn.addEventListener('click', () => {
      const answered = Object.keys(state.userAnswers).length;
      const total = state.questions.length;
      if (answered < total) {
        if (!confirm(`คุณทำข้อสอบไปแล้ว ${answered} จาก ${total} ข้อ\nต้องการส่งกระดาษคำตอบเลยหรือไม่?`)) {
          return;
        }
      }
      submitExam();
    });

    // Flashcard Scene Flip
    dom.card3d.addEventListener('click', flipFlashcard);
    dom.fcFlipBtn.addEventListener('click', flipFlashcard);

    dom.fcPrevBtn.addEventListener('click', () => {
      if (state.currentIndex > 0) {
        state.currentIndex--;
        AudioEngine.play('click');
        renderFlashcard();
      }
    });

    dom.fcNextBtn.addEventListener('click', () => {
      if (state.currentIndex < state.questions.length - 1) {
        state.currentIndex++;
        AudioEngine.play('click');
        renderFlashcard();
      }
    });

    // Score Modal buttons
    dom.scoreRetakeBtn.addEventListener('click', () => {
      dom.scoreModal.style.display = 'none';
      state.userAnswers = {};
      state.practiceChecked = {};
      state.flagged.clear();
      state.isSubmitted = false;
      state.currentIndex = 0;
      startTimer();
      renderAll();
    });

    dom.scoreReviewMistakesBtn.addEventListener('click', () => {
      dom.scoreModal.style.display = 'none';
      // Jump to first wrong answer
      const firstWrongIndex = state.questions.findIndex(q => !isAnswerCorrect(q, state.userAnswers[q.id]));
      if (firstWrongIndex !== -1) {
        state.currentIndex = firstWrongIndex;
      }
      renderQuestion();
      renderMatrix();
    });

    dom.scoreCloseBtn.addEventListener('click', () => {
      dom.scoreModal.style.display = 'none';
    });

    // Keyboard Shortcuts
    document.addEventListener('keydown', (e) => {
      // Don't trigger if typing in text input
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
        return;
      }

      if (state.mode === 'flashcard') {
        if (e.code === 'Space') {
          e.preventDefault();
          flipFlashcard();
        } else if (e.key === 'ArrowLeft') {
          dom.fcPrevBtn.click();
        } else if (e.key === 'ArrowRight') {
          dom.fcNextBtn.click();
        }
        return;
      }

      if (e.key === 'ArrowLeft') {
        dom.prevBtn.click();
      } else if (e.key === 'ArrowRight') {
        dom.nextBtn.click();
      } else if (e.key === 'f' || e.key === 'F') {
        dom.flagBtn.click();
      } else if (['1', '2', '3', '4'].includes(e.key)) {
        const q = state.questions[state.currentIndex];
        const optIdx = parseInt(e.key, 10) - 1;
        if (q && (q.options || q.options_th) && optIdx < (q.options || q.options_th).length) {
          selectOption(q, optIdx);
        }
      }
    });
  }

  function renderAll() {
    renderQuestion();
    renderMatrix();
    if (state.mode === 'flashcard') {
      renderFlashcard();
    }
  }

  // App Initialization
  function init() {
    initDOM();
    
    // Update Tab Badges Dynamically from QUESTION_BANK
    try {
      const pCount = (QUESTION_BANK.pretest || []).length;
      const eCount = (QUESTION_BANK.exam || []).length;
      const lCount = (QUESTION_BANK.lab || []).length;
      const nCount = (QUESTION_BANK.ncsa || []).length;
      const mCount = pCount + eCount + lCount + nCount;

      const pBadge = document.querySelector('#tab-pretest .tab-badge');
      if (pBadge) pBadge.textContent = `${pCount} ข้อ`;
      const eBadge = document.querySelector('#tab-exam .tab-badge');
      if (eBadge) eBadge.textContent = `${eCount} ข้อ`;
      const lBadge = document.querySelector('#tab-lab .tab-badge');
      if (lBadge) lBadge.textContent = `${lCount} ข้อ`;
      const nBadge = document.querySelector('#tab-ncsa .tab-badge');
      if (nBadge) nBadge.textContent = `${nCount} ข้อ`;
      const mBadge = document.querySelector('#tab-mock .tab-badge');
      if (mBadge) mBadge.textContent = `${mCount} ข้อ`;
    } catch (err) {
      // Ignore badge update failure
    }

    // iOS Safari Audio Unlock on first interaction
    const unlockAudio = () => {
      AudioEngine.unlock();
      document.removeEventListener('touchstart', unlockAudio);
      document.removeEventListener('click', unlockAudio);
    };
    document.addEventListener('touchstart', unlockAudio, { once: true, passive: true });
    document.addEventListener('click', unlockAudio, { once: true, passive: true });

    setupEvents();
    switchSection('pretest');
  }

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
