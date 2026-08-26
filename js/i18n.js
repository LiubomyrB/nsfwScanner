// @ts-nocheck — plain classic-script module; VMI18n is wired as a window global, same
// pattern as VMDB/VMScanner/VMTranscoder/VMMediabunnyPlayer/VMAssExport.
//
// Two languages: Ukrainian (default) and English. `t(key, params)` looks up `key` in the
// current language, falling back to English then to the raw key if missing (so a missing
// translation degrades to *something* visible instead of throwing or rendering blank).
// A dictionary entry can be a plain string (with {name}-style interpolation) or a plural-form
// object ({ one, few, many, other }, picked via Intl.PluralRules — Ukrainian has 3 numeric
// forms, not just singular/plural, so a naive count===1 check would misgrammar e.g. "5
// файлів"/"2 файли"/"21 файл").
(function (global) {
  const translations = {
    en: {
      "toolbar.settings": "Settings",
      "toolbar.openFileTitle": "Open another video file",
      "toolbar.openFile": "Open file",
      "toolbar.timecodesTitle": "Show detected timecodes",
      "toolbar.timecodes": "Timecodes",
      "toolbar.languageTitle": "Switch to Ukrainian",
      "toolbar.languageLabel": "УКР",

      "start.openVideo": "🎬 Open Video File",
      "start.resumeText": 'Resume "{fileName}" from {time}?',
      "start.resumeBtn": "▶ Resume last video",
      "start.startOver": "start over instead",

      "scan.heading": "Scanning video for nudity…",
      "scan.cancel": "cancel",
      "scan.statusLoadingModel": "Loading model…",
      "scan.statusPreparingVideo": "Preparing video…",
      "scan.statusCoarsePass": "Scanning (coarse pass)…",
      "scan.statusScanningFrames": "Scanning frames…",
      "scan.statusScanningFramesNudenet": "Scanning frames with body-part detector…",
      "scan.statusRefining": {
        one: "Refining {count} detected region…",
        few: "Refining {count} detected regions…",
        many: "Refining {count} detected regions…",
        other: "Refining {count} detected regions…",
      },
      "scan.statusConfirming": {
        one: "Confirming {count} region with body-part detector{suffix}",
        few: "Confirming {count} regions with body-part detector{suffix}",
        many: "Confirming {count} regions with body-part detector{suffix}",
        other: "Confirming {count} regions with body-part detector{suffix}",
      },
      "scan.confirmingSkippedSuffix": {
        one: " ({count} nearby sample reused from neighbors)…",
        few: " ({count} nearby samples reused from neighbors)…",
        many: " ({count} nearby samples reused from neighbors)…",
        other: " ({count} nearby samples reused from neighbors)…",
      },
      "scan.confirmingNoSkippedSuffix": "…",
      "scan.workerRole.scan": "scan",
      "scan.workerRole.confirmation": "confirmation",
      "scan.workerRole.detector": "detector",
      "scan.statusStartingWorkers": {
        one: "Starting {count} {role} worker…",
        few: "Starting {count} {role} workers…",
        many: "Starting {count} {role} workers…",
        other: "Starting {count} {role} workers…",
      },
      "scan.statusUsingWorkers": {
        one: "Using {count} {role} worker ({backend})…",
        few: "Using {count} {role} workers ({backend})…",
        many: "Using {count} {role} workers ({backend})…",
        other: "Using {count} {role} workers ({backend})…",
      },
      "scan.failed": "Scanning failed: {message}",

      "transcode.heading": "Converting video for playback…",
      "transcode.cancel": "cancel",
      "transcode.statusStarting": "Starting FFmpeg…",
      "transcode.statusDownloadingEngine": "Downloading FFmpeg engine…",
      "transcode.statusMounting": "Mounting video file…",
      "transcode.statusLoadingMemfs": "Loading video into FFmpeg (MEMFS)…",
      "transcode.statusFull": "Transcoding to MP4 (H.264/AAC)…",
      "transcode.statusAudioOnly": "Converting audio track (video left untouched)…",
      "transcode.notCrossOriginIsolated": "This page is not cross-origin isolated (missing Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy response headers), so the multithreaded FFmpeg engine cannot start in this browser session.",
      "transcode.nonZeroExit": "FFmpeg exited with a non-zero status ({code}).",
      "transcode.failed": "Video conversion failed: {message}",

      "player.play": "Play",
      "player.pause": "Pause",
      "player.mute": "Mute",
      "player.unmute": "Unmute",
      "player.fullscreen": "Fullscreen",
      "player.exitFullscreen": "Exit fullscreen",
      "player.audioTrack": "Audio track",
      "player.audioTrackNumbered": "Track {n}",
      "player.audioTrackNumberedLang": "Track {n} ({lang})",
      "player.blurredBadge": "🔒 blurred",
      "player.convertedSuffix": " (converted for playback)",
      "player.fullscreenFailed": "Failed to enter fullscreen.",

      "existingDialog.title": "Existing scan found",
      "existingDialog.text": "This video ({fileName}) was already scanned before.",
      "existingDialog.useExisting": "Use existing timecodes",
      "existingDialog.rescan": "Rescan video",

      "timecodesDialog.title": "Timecodes",
      "timecodesDialog.download": "Download",
      "timecodesDialog.downloadSubtitles": "Download as subtitles",
      "timecodesDialog.close": "Close",
      "timecodesDialog.none": "(no timecodes recorded for this scan)",
      "timecodesDialog.scanStats": {
        one: "Scan finished in {duration} — {count} scene detected.",
        few: "Scan finished in {duration} — {count} scenes detected.",
        many: "Scan finished in {duration} — {count} scenes detected.",
        other: "Scan finished in {duration} — {count} scenes detected.",
      },

      "assInfoDialog.title": "Save subtitle file",
      "assInfoDialog.textHtml": 'When you click "Save", pick the <strong>same folder where the video file is located</strong>, and keep the suggested file name. Most media players automatically load a subtitle file with the same name as the video, sitting next to it — once saved there, this subtitle will automatically cover the screen when a detected scene plays, even outside this app.',
      "assInfoDialog.save": "Save",
      "assInfoDialog.close": "Close",

      "transcodeWarning.videoTitle": "Format not supported for playback",
      "transcodeWarning.videoReason": "Your browser can't play",
      "transcodeWarning.videoSuffix": "directly (unsupported container/codec). It can be converted to MP4 (H.264/AAC) locally in your browser using FFmpeg before scanning and playback. This runs entirely on your device — nothing is uploaded anywhere — but it can take a while for large files.",
      "transcodeWarning.audioTitle": "Audio format not supported",
      "transcodeWarning.audioReason": "Your browser can play the video in",
      "transcodeWarning.audioSuffix": "but not its audio track (unsupported audio codec). Only the audio needs to be converted — the video stays untouched, so this should be quick — done locally in your browser using FFmpeg. Nothing is uploaded anywhere.",
      "transcodeWarning.confirm": "Convert with FFmpeg",
      "transcodeWarning.cancel": "Cancel",

      "settings.title": "Settings",
      "settings.sensitivity": "Sensitivity",
      "settings.sensitivityHint": "Blur triggers only when detected probability is ≥ this value.",
      "settings.classThresholdsHeading": "Per-class sensitivity",
      "settings.classThresholdsHint": "Fine-tune sensitivity separately for each detected body part. A sample only counts as detected if at least one of these is met — the general sensitivity above then decides whether that counts as enough to blur.",
      "settings.classFemaleBreastBare": "Female breast",
      "settings.classFemaleVagina": "Female genitals",
      "settings.classMalePenis": "Male genitals",
      "settings.classAnusBare": "Anus",
      "settings.classButtocksBare": "Buttocks",
      "timecodesDialog.classThresholdsHint": "Adjust which body parts count as detected — the list below updates live, and these values are also used when exporting timecodes/subtitles.",
      "settings.blurAdvance": "Blur in advance (seconds)",
      "settings.blurAdvanceHint": "Start blurring this many seconds before a flagged scene begins, and keep it blurred for this many seconds after the scene ends.",
      "settings.scanInterval": "Scan interval (seconds)",
      "settings.scanIntervalHint": "Gap between sampled frames while scanning. Smaller = more accurate scene start/end times, but a slower scan. With adaptive scan (below) on, this is the gap used inside a region it's already refining — the initial sweep of the rest of the video uses a coarser, auto-derived gap (roughly 5x this value, capped at 5s) regardless of how small you set this. Turn adaptive scan off if you need this exact gap applied everywhere. Applies to scans started after this is changed — rescan a video to apply it retroactively.",
      "settings.scanIntervalComputedBoth": "1st pass (whole video): every {coarse}s. 2nd pass (regions it flags): every {fine}s.",
      "settings.scanIntervalComputedSingle": "Applied everywhere: every {fine}s.",
      "settings.adaptiveScan": "Adaptive two-pass scan (faster)",
      "settings.adaptiveScanHint": "Scans a fast coarse pass first (gap: roughly 5x the scan interval above, capped at 5s), then re-scans at the full scan-interval precision only around anything that pass finds. Much faster on long videos, since most of a video is usually clean. A scene shorter than the coarse pass's gap that falls entirely between two clean coarse samples can still be missed — turn this off for maximum thoroughness on content you don't trust a coarse pass with, or on content with very brief scenes. Changing this — like scan interval — only affects scans started afterward.",
      "settings.detectionMethod": "Detection method",
      "settings.modeNsfwjs": "NSFWJS only (fastest)",
      "settings.modeConfirm": "NSFWJS + NudeNet confirmation (recommended)",
      "settings.modeNudenet": "NudeNet only (most precise, slowest)",
      "settings.detectionHint": 'NSFWJS alone sometimes flags frames with a lot of visible skin but no actual nudity (bare neck/shoulders/midriff, etc) — it has no real anatomical understanding. NudeNet is a real body-part detector: it only counts a frame if it specifically finds an exposed breast, genitals, or anus. "Confirmation" uses NSFWJS as a cheap first pass and only asks NudeNet to double-check frames NSFWJS already flagged — good balance of speed and accuracy. "NudeNet only" skips NSFWJS entirely and runs the body-part detector directly on every sampled frame — most accurate, since NSFWJS never gets a vote. Either NudeNet mode downloads its ~12MB model the first time it\'s needed.',
      "settings.exactTiming": "Exact NudeNet timing (no averaging)",
      "settings.exactTimingHint": 'Whenever NudeNet checks several nearby frames in a row (a sustained scene), it normally only classifies a few of them and fills in the rest by copying the nearest one\'s result — fast, but the scene\'s start/end time is only as precise as which frames happened to get checked. Turn this on to classify every single candidate frame with NudeNet instead, giving the real scene-boundary time at your configured scan interval — more NudeNet calls, so slower. Only matters for "confirmation" and "NudeNet only" detection modes above; ignored for NSFWJS-only.',
      "settings.rememberState": "Remember state after reload",
      "settings.close": "Close",

      "intertitle.text": "Censored scene",
    },

    uk: {
      "toolbar.settings": "Налаштування",
      "toolbar.openFileTitle": "Відкрити інший відеофайл",
      "toolbar.openFile": "Відкрити файл",
      "toolbar.timecodesTitle": "Показати знайдені таймкоди",
      "toolbar.timecodes": "Таймкоди",
      "toolbar.languageTitle": "Switch to English",
      "toolbar.languageLabel": "ENG",

      "start.openVideo": "🎬 Відкрити відеофайл",
      "start.resumeText": 'Продовжити перегляд «{fileName}» з {time}?',
      "start.resumeBtn": "▶ Продовжити останнє відео",
      "start.startOver": "почати спочатку",

      "scan.heading": "Сканування відео на наявність оголеності…",
      "scan.cancel": "скасувати",
      "scan.statusLoadingModel": "Завантаження моделі…",
      "scan.statusPreparingVideo": "Підготовка відео…",
      "scan.statusCoarsePass": "Сканування (грубий прохід)…",
      "scan.statusScanningFrames": "Сканування кадрів…",
      "scan.statusScanningFramesNudenet": "Сканування кадрів детектором частин тіла…",
      "scan.statusRefining": {
        one: "Уточнення {count} знайденої ділянки…",
        few: "Уточнення {count} знайдених ділянок…",
        many: "Уточнення {count} знайдених ділянок…",
        other: "Уточнення {count} знайдених ділянок…",
      },
      "scan.statusConfirming": {
        one: "Підтвердження {count} ділянки детектором частин тіла{suffix}",
        few: "Підтвердження {count} ділянок детектором частин тіла{suffix}",
        many: "Підтвердження {count} ділянок детектором частин тіла{suffix}",
        other: "Підтвердження {count} ділянок детектором частин тіла{suffix}",
      },
      "scan.confirmingSkippedSuffix": {
        one: " ({count} сусідній кадр узято із сусідніх)…",
        few: " ({count} сусідні кадри узято із сусідніх)…",
        many: " ({count} сусідніх кадрів узято із сусідніх)…",
        other: " ({count} сусідніх кадрів узято із сусідніх)…",
      },
      "scan.confirmingNoSkippedSuffix": "…",
      "scan.workerRole.scan": "сканування",
      "scan.workerRole.confirmation": "підтвердження",
      "scan.workerRole.detector": "детектор",
      "scan.statusStartingWorkers": {
        one: "Запуск {count} воркера ({role})…",
        few: "Запуск {count} воркерів ({role})…",
        many: "Запуск {count} воркерів ({role})…",
        other: "Запуск {count} воркерів ({role})…",
      },
      "scan.statusUsingWorkers": {
        one: "Використовується {count} воркер ({role}, {backend})…",
        few: "Використовується {count} воркери ({role}, {backend})…",
        many: "Використовується {count} воркерів ({role}, {backend})…",
        other: "Використовується {count} воркерів ({role}, {backend})…",
      },
      "scan.failed": "Помилка сканування: {message}",

      "transcode.heading": "Конвертація відео для відтворення…",
      "transcode.cancel": "скасувати",
      "transcode.statusStarting": "Запуск FFmpeg…",
      "transcode.statusDownloadingEngine": "Завантаження движка FFmpeg…",
      "transcode.statusMounting": "Підключення відеофайлу…",
      "transcode.statusLoadingMemfs": "Завантаження відео у FFmpeg (MEMFS)…",
      "transcode.statusFull": "Конвертація у MP4 (H.264/AAC)…",
      "transcode.statusAudioOnly": "Конвертація аудіодоріжки (відео залишається без змін)…",
      "transcode.notCrossOriginIsolated": "Ця сторінка не є cross-origin isolated (відсутні заголовки відповіді Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy), тому багатопотоковий движок FFmpeg не може запуститися в цьому сеансі браузера.",
      "transcode.nonZeroExit": "FFmpeg завершився з ненульовим кодом ({code}).",
      "transcode.failed": "Помилка конвертації відео: {message}",

      "player.play": "Відтворити",
      "player.pause": "Пауза",
      "player.mute": "Вимкнути звук",
      "player.unmute": "Увімкнути звук",
      "player.fullscreen": "Повноекранний режим",
      "player.exitFullscreen": "Вийти з повноекранного режиму",
      "player.audioTrack": "Аудіодоріжка",
      "player.audioTrackNumbered": "Доріжка {n}",
      "player.audioTrackNumberedLang": "Доріжка {n} ({lang})",
      "player.blurredBadge": "🔒 розмито",
      "player.convertedSuffix": " (конвертовано для відтворення)",
      "player.fullscreenFailed": "Не вдалося увімкнути повноекранний режим.",

      "existingDialog.title": "Знайдено попереднє сканування",
      "existingDialog.text": "Це відео ({fileName}) вже було відскановане раніше.",
      "existingDialog.useExisting": "Використати наявні таймкоди",
      "existingDialog.rescan": "Пересканувати відео",

      "timecodesDialog.title": "Таймкоди",
      "timecodesDialog.download": "Завантажити",
      "timecodesDialog.downloadSubtitles": "Завантажити як субтитри",
      "timecodesDialog.close": "Закрити",
      "timecodesDialog.none": "(для цього сканування таймкодів не записано)",
      "timecodesDialog.scanStats": {
        one: "Сканування завершено за {duration} — знайдено {count} сцену.",
        few: "Сканування завершено за {duration} — знайдено {count} сцени.",
        many: "Сканування завершено за {duration} — знайдено {count} сцен.",
        other: "Сканування завершено за {duration} — знайдено {count} сцен.",
      },

      "assInfoDialog.title": "Зберегти файл субтитрів",
      "assInfoDialog.textHtml": 'Натиснувши «Зберегти», оберіть <strong>ту саму папку, де знаходиться відеофайл</strong>, і залиште запропоновану назву файлу без змін. Більшість медіаплеєрів автоматично завантажують файл субтитрів з такою самою назвою, як і у відео, що лежить поруч — після збереження туди ці субтитри автоматично закриватимуть екран під час відтворення знайденої сцени, навіть поза цим застосунком.',
      "assInfoDialog.save": "Зберегти",
      "assInfoDialog.close": "Закрити",

      "transcodeWarning.videoTitle": "Формат не підтримується для відтворення",
      "transcodeWarning.videoReason": "Ваш браузер не може відтворити",
      "transcodeWarning.videoSuffix": "напряму (непідтримуваний контейнер/кодек). Його можна конвертувати у MP4 (H.264/AAC) локально у браузері за допомогою FFmpeg перед скануванням і відтворенням. Це виконується повністю на вашому пристрої — нічого нікуди не завантажується — але для великих файлів це може зайняти певний час.",
      "transcodeWarning.audioTitle": "Формат аудіо не підтримується",
      "transcodeWarning.audioReason": "Ваш браузер може відтворити відео у файлі",
      "transcodeWarning.audioSuffix": "але не його аудіодоріжку (непідтримуваний аудіокодек). Конвертувати потрібно лише аудіо — відео залишається без змін, тому це має бути швидко — і виконується локально у браузері за допомогою FFmpeg. Нічого нікуди не завантажується.",
      "transcodeWarning.confirm": "Конвертувати через FFmpeg",
      "transcodeWarning.cancel": "Скасувати",

      "settings.title": "Налаштування",
      "settings.sensitivity": "Чутливість",
      "settings.sensitivityHint": "Розмиття вмикається лише коли виявлена ймовірність ≥ цього значення.",
      "settings.classThresholdsHeading": "Чутливість за категоріями",
      "settings.classThresholdsHint": "Налаштуйте чутливість окремо для кожної виявленої частини тіла. Зразок вважається виявленим, лише якщо виконано хоча б одну з цих умов — загальна чутливість вище тоді вирішує, чи достатньо цього для розмиття.",
      "settings.classFemaleBreastBare": "Жіночі груди",
      "settings.classFemaleVagina": "Жіночі статеві органи",
      "settings.classMalePenis": "Чоловічі статеві органи",
      "settings.classAnusBare": "Анус",
      "settings.classButtocksBare": "Сідниці",
      "timecodesDialog.classThresholdsHint": "Налаштуйте, які частини тіла вважаються виявленими — список нижче оновлюється одразу, і ці значення також використовуються при експорті таймкодів/субтитрів.",
      "settings.blurAdvance": "Розмиття завчасно (секунди)",
      "settings.blurAdvanceHint": "Починати розмиття за стільки секунд до початку позначеної сцени, і залишати розмиття ще стільки ж секунд після її закінчення.",
      "settings.scanInterval": "Інтервал сканування (секунди)",
      "settings.scanIntervalHint": "Проміжок між кадрами, що вибираються під час сканування. Менше значення = точніший час початку/кінця сцени, але повільніше сканування. Коли адаптивне сканування (нижче) увімкнене, це проміжок, що використовується всередині ділянки, яка вже уточнюється — початковий прохід по решті відео використовує грубіший, автоматично визначений проміжок (приблизно у 5 разів більший за це значення, але не більше 5с) незалежно від того, наскільки малим ви його зробите. Вимкніть адаптивне сканування, якщо потрібно, щоб цей точний проміжок застосовувався всюди. Застосовується до сканувань, розпочатих після зміни — пересканйте відео, щоб застосувати це заднім числом.",
      "settings.scanIntervalComputedBoth": "1-й прохід (усе відео): кожні {coarse}с. 2-й прохід (позначені ділянки): кожні {fine}с.",
      "settings.scanIntervalComputedSingle": "Застосовується всюди: кожні {fine}с.",
      "settings.adaptiveScan": "Адаптивне дворазове сканування (швидше)",
      "settings.adaptiveScanHint": "Спочатку виконує швидкий грубий прохід (проміжок: приблизно у 5 разів більший за інтервал сканування вище, але не більше 5с), потім пересканує з повною точністю інтервалу сканування лише ті ділянки, які знайшов той прохід. Значно швидше на довгих відео, оскільки більша частина відео зазвичай «чиста». Сцену, коротшу за проміжок грубого проходу, що повністю потрапляє між двома «чистими» грубими кадрами, все ще можна пропустити — вимкніть це для максимальної ретельності на контенті, якому ви не довіряєте грубий прохід, або на контенті з дуже короткими сценами. Зміна цього параметра — як і інтервалу сканування — впливає лише на сканування, розпочаті після зміни.",
      "settings.detectionMethod": "Метод виявлення",
      "settings.modeNsfwjs": "Лише NSFWJS (найшвидше)",
      "settings.modeConfirm": "NSFWJS + підтвердження NudeNet (рекомендовано)",
      "settings.modeNudenet": "Лише NudeNet (найточніше, найповільніше)",
      "settings.detectionHint": 'Сам по собі NSFWJS іноді позначає кадри з великою кількістю видимої шкіри, але без фактичної оголеності (відкрита шия/плечі/живіт тощо) — він не має справжнього анатомічного розуміння. NudeNet — це справжній детектор частин тіла: він враховує кадр лише якщо конкретно знаходить оголені груди, статеві органи або анус. «Підтвердження» використовує NSFWJS як дешевий перший прохід і лише просить NudeNet перевірити кадри, які NSFWJS уже позначив — гарний баланс швидкості й точності. «Лише NudeNet» повністю пропускає NSFWJS і запускає детектор частин тіла напряму на кожному вибраному кадрі — найточніше, оскільки NSFWJS взагалі не бере участі. Будь-який режим NudeNet завантажує свою модель (~12МБ) при першій потребі.',
      "settings.exactTiming": "Точний час NudeNet (без усереднення)",
      "settings.exactTimingHint": "Коли NudeNet перевіряє кілька сусідніх кадрів поспіль (тривалу сцену), він зазвичай класифікує лише декілька з них, а решту заповнює, копіюючи результат найближчого — швидко, але час початку/кінця сцени лише настільки точний, наскільки точно обрано перевірені кадри. Увімкніть це, щоб класифікувати кожен окремий кадр-кандидат за допомогою NudeNet, отримуючи справжній час межі сцени з вашим налаштованим інтервалом сканування — більше викликів NudeNet, тому повільніше. Має значення лише для режимів «підтвердження» та «лише NudeNet» вище; ігнорується для NSFWJS.",
      "settings.rememberState": "Пам'ятати стан після перезавантаження",
      "settings.close": "Закрити",

      "intertitle.text": "Сцену приховано",
    },
  };

  let currentLang = "uk";

  function interpolate(str, params) {
    if (!params) return str;
    return str.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
  }

  function resolveEntry(lang, key) {
    const dict = translations[lang];
    return dict && Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : undefined;
  }

  function t(key, params) {
    let entry = resolveEntry(currentLang, key);
    if (entry === undefined) entry = resolveEntry("en", key);
    if (entry === undefined) return key;

    if (typeof entry === "object") {
      const n = params && typeof params.count === "number" ? params.count : 0;
      let rule;
      try {
        rule = new Intl.PluralRules(currentLang).select(n);
      } catch (e) {
        rule = n === 1 ? "one" : "other";
      }
      const form = entry[rule] || entry.other || entry.many || entry.few || entry.one || "";
      return interpolate(form, params);
    }
    return interpolate(entry, params);
  }

  function getLanguage() {
    return currentLang;
  }

  function setLanguage(lang) {
    currentLang = translations[lang] ? lang : "uk";
  }

  // Applies translations to every element under `root` (default: whole document) carrying
  // one of these data-i18n-* attributes. Called once on load and again after setLanguage().
  function applyToDom(root) {
    root = root || document;
    root.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    root.querySelectorAll("[data-i18n-html]").forEach((el) => {
      el.innerHTML = t(el.getAttribute("data-i18n-html"));
    });
    root.querySelectorAll("[data-i18n-title]").forEach((el) => {
      el.title = t(el.getAttribute("data-i18n-title"));
    });
    root.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
      el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria-label")));
    });
    root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      el.placeholder = t(el.getAttribute("data-i18n-placeholder"));
    });
  }

  global.VMI18n = { t, getLanguage, setLanguage, applyToDom, translations };
})(window);
