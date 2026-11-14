// Plotweaver — Alter: стартовые точки для новых персонажей.
//
// Маленький, самостоятельный модуль поверх уже готовой машинерии: контекст
// (карточка + первое сообщение + лорбук) берём из prompt.js, генерацию — из
// generate.js, сохранение — из settings.js (страница с kind: 'persona').
// Своего каталога-с-секциями тут не нужно — полей всего пять.

import { buildContext } from './prompt.js';
import { runGeneration, stopMainApiGeneration } from './generate.js';
import { addPage, getAlterDraft, saveAlterDraftDebounced, getAlterLast, saveAlterLast, getAlterStopList, setAlterStopList } from './settings.js';
import { modelSectionHtml, loreSelectHtml, getDefaultCharacterLoreName } from './ui.js';

function ctx() {
    return SillyTavern.getContext();
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** Все уникальные имена сохранённых Persona (для "избегать уже занятых имён"). */
function getAllPersonaNames() {
    try {
        const personas = ctx().powerUserSettings?.personas || {};
        return [...new Set(Object.values(personas))].filter(Boolean);
    } catch (error) {
        console.warn('[Plotweaver] не удалось получить список персон', error);
        return [];
    }
}

const GENDER_OPTIONS = [
    { id: 'male', label: 'Male' },
    { id: 'female', label: 'Female' },
    { id: 'any', label: 'Любой' },
];

const ROLE_CANON_OPTIONS = [
    { id: 'yes', label: 'Да' },
    { id: 'no', label: 'Нет' },
];

const INVENTION_OPTIONS = [
    { id: 'canon', label: 'Строго канон' },
    { id: 'balanced', label: 'Средне' },
    { id: 'free', label: 'Смело' },
];

// Мускус и озон намеренно нет в списке и явно запрещены в промте — автор
// не хочет их видеть вообще, даже если бы модель решила добавить сама.
const PHEROMONE_OPTIONS = [
    { id: 'sweet_floral', label: 'Сладкий/цветочный', labelEn: 'sweet floral' },
    { id: 'spicy_woody', label: 'Пряный/древесный', labelEn: 'spicy woody' },
    { id: 'citrus', label: 'Цитрусовый', labelEn: 'citrus' },
    { id: 'berry_fruity', label: 'Ягодный/фруктовый', labelEn: 'berry/fruity' },
    { id: 'vanilla', label: 'Ванильный', labelEn: 'vanilla' },
    { id: 'salty_sea', label: 'Солоноватый/морской', labelEn: 'salty/sea air' },
    { id: 'smoky_resinous', label: 'Дымный/смолистый', labelEn: 'smoky/resinous' },
    { id: 'herbal_green', label: 'Травяной/зелёный', labelEn: 'herbal/green' },
    { id: 'metallic_cold', label: 'Металлический/холодный', labelEn: 'metallic/cold' },
    { id: 'honey', label: 'Медовый', labelEn: 'honey' },
    { id: 'coffee_chocolate', label: 'Кофейный/шоколадный', labelEn: 'coffee/chocolate' },
    { id: 'earthy', label: 'Землистый', labelEn: 'earthy' },
];

// ---------------------------------------------------------------------------
// Промт
// ---------------------------------------------------------------------------

const INVENTION_TEXT = {
    canon: 'Stick strictly to what is already established in the character card and lorebook. Do not invent worldbuilding facts that contradict them.',
    balanced: 'Rely on the card/lorebook where they say something; where they are silent, feel free to invent logical, fitting details.',
    free: 'The card/lorebook are binding wherever they establish something, but where material is missing, invent generously and boldly.',
};

// ---------------------------------------------------------------------------
// Анти-слоп
// ---------------------------------------------------------------------------

const BACKGROUND_COUNT = 3;

// Случайные затравки: каждый бэкграунд строится вокруг своей пары
// «образ жизни × темперамент». Без них модель на одинаковый запрос выдаёт
// одного и того же персонажа (и попадает в кэш).
const LIFESTYLE_SEEDS = [
    'heir to old money, used to being spoiled',
    'student juggling studies and a part-time job',
    'owner of a small family business',
    'artist or performer still trying to make it',
    'professional athlete or competitive fighter',
    'respectable white-collar professional (law, medicine, finance)',
    'caregiver by trade (nurse, teacher, nanny, social worker)',
    'skilled tradesman or craftsman',
    'small-time hustler living off schemes',
    'academic or researcher obsessed with one subject',
    'minor celebrity or public figure',
    'service worker who genuinely loves the job (florist, baker, hairdresser, barista)',
    'soldier, guard or ex-military',
    'drifter with no fixed home',
    'clergy or someone raised deep inside a faith',
    'mid-level bureaucrat in a rigid institution',
    'middle child of a huge, loud family business',
    'runaway from a sheltered, overprotective upbringing',
    'engineer or tinkerer who lives in their workshop',
    'rural worker who finds the city exhausting',
    'chef or cook running a busy kitchen',
    'retired early, bored and looking for trouble',
];

const TEMPERAMENT_SEEDS = [
    'sunny and openly affectionate',
    'shy and soft-spoken',
    'loud, bratty and dramatic',
    'calm and nurturing',
    'cocky and flirtatious',
    'prim, proper and uptight',
    'chaotic and goofy',
    'quietly intense and stubborn',
    'sharp-tongued but kind',
    'earnest and a little naive',
    'cool, composed and aloof',
];

// Фамилии, которые модель затёрла до дыр (видны в генах подряд).
const OVERUSED_SURNAMES = [
    'Vance', 'Thorne', 'Mercer', 'Sterling', 'Cross', 'Blackwood', 'Hale',
    'Lindqvist', 'Gallagher', 'Novak', 'Solberg', 'Castellano', 'Brooks', 'Reyes',
];

/** n разных случайных элементов массива. */
function pickDistinct(list, n) {
    const pool = [...list];
    const out = [];
    while (out.length < n && pool.length) {
        out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    }
    return out;
}

/** Три пары «образ жизни × темперамент» на один ген. */
export function pickAlterSeeds() {
    const lifestyles = pickDistinct(LIFESTYLE_SEEDS, BACKGROUND_COUNT);
    const temperaments = pickDistinct(TEMPERAMENT_SEEDS, BACKGROUND_COUNT);
    return lifestyles.map((lifestyle, i) => ({ lifestyle, temperament: temperaments[i] }));
}


// Сколько слов пункта бэкграунда запоминаем для «не повторяй»: начала хватает,
// чтобы модель узнала занятие или реквизит, а промпт не раздувается.
const LAST_BULLET_WORDS = 12;

/** Имена, строки TYPE и начала пунктов из ответа — чтобы следующий ген их не повторял. */
export function parseAlterResult(text) {
    const names = [];
    const types = [];
    const bullets = [];
    let section = '';
    for (const rawLine of String(text || '').split('\n')) {
        const line = rawLine.replace(/\*\*/g, '').trim();
        const heading = line.match(/^#{1,3}\s*([A-Z]+)/);
        if (heading) { section = heading[1].toUpperCase(); continue; }
        if (section === 'NAMES') {
            const m = line.match(/^\d+[.)]\s*(.+)$/);
            if (m) names.push(m[1].trim());
        } else if (section === 'BACKGROUND') {
            const m = line.match(/^(?:\d+[.)]\s*)?TYPE:\s*(.+)$/i);
            if (m) { types.push(m[1].trim()); continue; }
            const b = line.match(/^[-*•]\s*(.+)$/);
            if (b) {
                const words = b[1].trim().split(/\s+/);
                bullets.push(words.slice(0, LAST_BULLET_WORDS).join(' ') + (words.length > LAST_BULLET_WORDS ? '…' : ''));
            }
        }
    }
    return { names: names.slice(0, 20), types: types.slice(0, 10), bullets: bullets.slice(0, 36) };
}

/**
 * Собирает промт для Alter.
 * params: { contextText, gender, species, pheromoneLabels, notes, connection, invention, avoidNames, seeds, lastGen, stopList, roleCanon }
 */
function buildAlterPrompt({ contextText, gender, species, pheromoneLabels, notes, connection, invention, avoidNames, seeds = [], lastGen = null, stopList = '', roleCanon = true }) {
    const parts = [];

    parts.push(
        'You are helping generate a STARTING POINT for the USER PERSONA — the character '
        + 'the human author will personally roleplay as ({{user}}), opposite the character '
        + 'card provided below. This is NOT a new side character, NOT an NPC, and NOT '
        + 'someone from the bot\'s own story — it is the author\'s own player character. '
        + 'The character card and first message below are CONTEXT ONLY: they tell you what '
        + 'world and what person this persona will be interacting with. Do not retell, '
        + 'summarize, or borrow from the bot\'s own backstory.\n\n'
        + 'This is not a finished character sheet, not prose, not a finished bio. The author '
        + 'will mix and match pieces afterward (a name from one option, a personality block '
        + 'from another) — so give independent, varied options, not matching characters.',
    );
    parts.push('Write everything in English.');
    parts.push(
        'THIS IS A STARTING POINT, NOT A CHARACTER BIBLE.\n'
        + 'No atmospheric description, no backstory paragraphs, no flowery language. '
        + 'Personality is single-word traits only. Background is concrete bullet points — '
        + 'each one a specific, vivid fact, not a memoir.',
    );

    if (contextText) parts.push(contextText);

    if (roleCanon) {
        // Автор сказал: роль юзера задана в карточке — она канон для всех вариантов.
        parts.push(
            "# {{user}}'S ROLE IS CANON (MANDATORY)\n"
            + 'The card and first message already define who {{user}} is in this story. Find '
            + 'everything they state about {{user}} — position, job, status, situation, disguise, '
            + 'circumstances — and keep ALL of it in EVERY variation. Do not give {{user}} a different '
            + 'job, rank or situation, and do not upgrade or "improve" the role: if {{user}} is a '
            + 'lowly servant, every variation is that lowly servant, and that is enough.\n'
            + 'Vary only what the card leaves open: temperament, how they carry the role and feel '
            + 'about it, habits, small skills, tastes, friendships and grudges, a secret, a want, '
            + 'a little of where they came from.',
        );
    } else {
        parts.push(
            '# THE OPENING SCENE IS ONE MOMENT (MANDATORY)\n'
            + 'The card and first message show one moment of the bot\'s story. Do not build the '
            + 'persona\'s whole life around that moment: if the scene happens at night, in a '
            + 'hospital, after a crime or at a death, that says nothing about the persona\'s job, '
            + 'schedule, habits or temperament. The persona had a full, ordinary-for-them life before it.',
        );
    }

    const briefLines = [];
    if (gender) briefLines.push(`- Gender/pronouns: ${gender}`);
    if (species) briefLines.push(`- Race/species (take this into account for background${pheromoneLabels.length ? ' and scent' : ''}; do not describe how it looks): ${species}`);
    if (connection) briefLines.push(`- Role and connection to this bot/story — canon for every background variation, shape all bullets around it, not just one: ${connection}`);
    if (briefLines.length) {
        parts.push(`# AUTHOR'S BRIEF (MANDATORY)\n${briefLines.join('\n')}`);
    }

    if (!connection) {
        parts.push(
            '# CONNECTION TO THE BOT\n'
            + 'The author gave no connection. Each variation may have at most one bullet about it, '
            + 'or none. If you use one, every variation must use a DIFFERENT hook from the card or '
            + 'lore — never the same organization, place or person twice, and not the most obvious one by default.',
        );
    }

    if (avoidNames && avoidNames.length) {
        parts.push(
            "# NAMES ALREADY IN USE (MANDATORY)\n"
            + 'Do not use any of these names for the new character — they already belong to '
            + `existing personas: ${avoidNames.join(', ')}.`,
        );
    }

    if (notes && notes.trim()) {
        parts.push(`# FREE-FORM NOTES AND WISHES (MANDATORY)\n${notes.trim()}`);
    }

    parts.push(`# HOW MUCH TO INVENT\n${INVENTION_TEXT[invention] || INVENTION_TEXT.balanced}`);

    parts.push(
        '# BANNED — CLICHÉS (MANDATORY)\n'
        + 'These are overused and specifically unwanted. Never use them anywhere, in any variation:\n'
        + '- phobias and fears (deep water, heights, enclosed spaces, crowds, the dark…) — '
        + 'not as a quirk and not as backstory;\n'
        + '- insomnia, being nocturnal, night jobs, night shifts or a graveyard schedule — none at all;\n'
        + '- collecting vinyl records, cassettes, film cameras, vintage cars or any other "retro" collection;\n'
        + '- illnesses, allergies, injuries, scars, hearing loss, partial deafness/blindness or chronic '
        + 'pain — not as a quirk and not as backstory;\n'
        + '- stock props: black coffee by the pot, smoking "to cope", feeding stray animals, '
        + 'compulsive tidying or neatness, checking locks twice, memorizing transit schedules;\n'
        + '- stock hobbies: kayaking, gambling of any kind (poker, backgammon, betting);\n'
        + '- stock family beats: calling mom every Sunday, a big loud family of six or seven, '
        + 'a strict household — as a default upbringing;\n'
        + '- stock phrasing: "maintains a polite distance… preferring the company of", '
        + '"clashes constantly with";\n'
        + '- APPEARANCE of any kind: height, build, face, hair, eyes, glasses, skin, scars, tattoos, '
        + 'a crooked nose, clothing style. This tool is not about looks;\n'
        + `- SCENT or smell of any kind${pheromoneLabels.length ? ', except inside the SCENT section' : ''};\n`
        + '- states instead of personality traits (insomnia-prone, nocturnal, sleep-deprived).',
    );

    const stop = String(stopList || '').trim();
    if (stop) {
        parts.push(
            "# AUTHOR'S STOP-LIST (MANDATORY)\n"
            + 'The author never wants to see these, in any variation or section, in any form: '
            + stop,
        );
    }

    if (roleCanon) {
        parts.push(
            '# RANGE (MANDATORY)\n'
            + 'Your first idea is the cliché — skip it. Three DIFFERENT PEOPLE in the SAME role: '
            + 'different temperament, manner, habits, tastes and inner life, so that the same job '
            + 'feels like three different characters. If two variations could swap a bullet '
            + 'without anyone noticing, rewrite one of them.',
        );
    } else parts.push(
        '# RANGE (MANDATORY)\n'
        + 'Your first idea is the cliché — skip it. The variations must come from DIFFERENT WORLDS: '
        + 'different social class, adult age bracket, temperament, daily rhythm and way of life. '
        + 'The same chat can fit anyone from a towering bouncer to a sweet femboy florist, from '
        + 'an old-money heir to a broke student (these only show the range — do not reuse them). '
        + 'If two variations could swap a '
        + 'bullet without anyone noticing, rewrite one of them.',
    );

    if (seeds.length && roleCanon) {
        parts.push(
            '# SEEDS (MANDATORY)\n'
            + 'Each background variation gets a seed: past × temperament. The TEMPERAMENT shapes '
            + 'the whole variation. The PAST is only a hint for at most ONE bullet about where '
            + 'they came from before this role (e.g. "heir to old money" → a ruined heir who ended '
            + 'up in this role); it never changes the role itself. The author\'s brief and notes '
            + 'above win if they conflict with a seed.\n'
            + seeds.map((seed, i) => `${i + 1}. past: ${seed.lifestyle} × ${seed.temperament}`).join('\n'),
        );
    } else if (seeds.length) {
        parts.push(
            '# SEEDS (MANDATORY)\n'
            + 'Build each background variation around its seed: lifestyle × temperament. '
            + 'Adapt the seed to the setting (e.g. "heir to old money" becomes a noble scion in a '
            + 'fantasy world). The author\'s brief and notes above win if they conflict with a seed.\n'
            + seeds.map((seed, i) => `${i + 1}. ${seed.lifestyle} × ${seed.temperament}`).join('\n'),
        );
    }

    const lastNames = lastGen?.names?.length ? lastGen.names : [];
    const lastTypes = lastGen?.types?.length ? lastGen.types : [];
    const lastBullets = lastGen?.bullets?.length ? lastGen.bullets : [];
    if (lastNames.length || lastTypes.length || lastBullets.length) {
        parts.push(
            '# PREVIOUS GENERATION — DO NOT REPEAT (MANDATORY)\n'
            + 'The author already saw these. Do not reuse these first names or surnames, do not '
            + (roleCanon ? 'give a background with a similar temperament or type (the role itself stays), ' : 'give a background with a similar occupation or type, ')
            + 'and do not reuse the hobbies, '
            + 'props, tastes, family setups or phrasing from these bullets:\n'
            + (lastNames.length ? `- Names: ${lastNames.join(', ')}\n` : '')
            + (lastTypes.length ? `- Types: ${lastTypes.join('; ')}\n` : '')
            + (lastBullets.length ? `- Bullets:\n${lastBullets.map(b => `  - ${b}`).join('\n')}` : ''),
        );
    }

    const scentSection = pheromoneLabels.length
        ? `\n\n## SCENT\n5 variations of scent/pheromone notes, each incorporating: ${pheromoneLabels.join(', ')}. `
            + 'One short phrase per line, numbered 1-5.\n'
            + 'Never use "musk/musky" or "ozone" as a note, regardless of anything above — '
            + 'these are overused and specifically unwanted.'
        : '';

    parts.push(
        '# OUTPUT FORMAT (MANDATORY)\n'
        + 'Give exactly these sections, in this order, and nothing else:\n\n'
        + '## NAMES\n'
        + '10 full names (first + family name) fitting the setting, of varied origins and sounds — '
        + 'not ten variations of one noir cast. Avoid these worn-out surnames: '
        + `${OVERUSED_SURNAMES.join(', ')}. One per line, numbered 1-10.`
        + scentSection
        + '\n\n## PERSONALITY\n'
        + '5 variations. Each is 5-6 single-word traits, comma-separated '
        + '(e.g. "cheerful, clingy, melancholic, blunt, loyal"). One per line, numbered 1-5.\n'
        + 'Cover opposite poles: at least one warm/sunny, one soft/shy, one loud/bratty or cocky. '
        + 'Do not default to "cynical, observant, dry-humored, guarded" — at most one variation '
        + 'may be cool or guarded.\n\n'
        + '## BACKGROUND\n'
        + `${BACKGROUND_COUNT} variations. Each starts with a line "N. TYPE: <4-8 word tag>" that sums up `
        + (roleCanon
            ? 'who this person is: temperament + their canon role + one twist (do not reuse examples from this prompt), '
            : 'who this person is: temperament + who they are + one twist (do not reuse examples from this prompt), ')
        + 'followed by 8-10 bullet points of TRIVIA ABOUT THIS PERSONA THEMSELVES. Draw from: '
        + (roleCanon ? 'how they carry their role and feel about it' : 'how they earn a living and how they feel about it')
        + ', where and how they live, family and '
        + 'upbringing, what they are good at, what they do for fun, friends and who they clash '
        + 'with, a contradiction or small secret, what they want right now, a specific taste or '
        + 'guilty pleasure. Each bullet is one concrete fact, specific enough to belong to this '
        + 'person only.\n'
        + 'These topics are a MENU, not a checklist: skip some, give two bullets to others, and '
        + 'put them in a different order in every variation — no shared skeleton, and no variation '
        + 'ends on "wants…". Vary how bullets open: do not start them with "Spends his…", '
        + '"Secretly…", "Currently…" or "Wants…". A food or drink guilty pleasure may appear in '
        + 'at most one variation.\n'
        + 'At most ONE bullet per variation may mention how they know or relate to the bot; '
        + 'the rest must be about the persona alone. Do NOT retell the bot\'s backstory, do '
        + 'NOT summarize the events of the first message, and do NOT describe what the bot '
        + 'does or wants — those are already known.',
    );

    parts.push(
        'FINAL REMINDER: starting point, not prose. No appearance, no scent outside SCENT, '
        + 'no phobias, no insomnia, no retro collections. Three people from three different '
        + 'worlds, built on their seeds.',
    );

    return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Окно
// ---------------------------------------------------------------------------

function chipRowHtml(name, options, selectedIds) {
    return options
        .map((opt) => `<div class="pw-chip ${selectedIds.includes(opt.id) ? 'pw-chip--active' : ''}" data-name="${name}" data-value="${opt.id}">${escapeHtml(opt.label)}</div>`)
        .join('');
}

function segmentedRowHtml(name, options, activeId) {
    return options
        .map((opt) => `<button type="button" class="pw-seg pw-alter-seg" data-name="${name}" data-value="${opt.id}" aria-pressed="${opt.id === activeId}">${escapeHtml(opt.label)}</button>`)
        .join('');
}

/** Окно с результатом — тот же принцип, что у Plotweaver, но сохраняет kind: 'persona'. */
async function openAlterResult(text) {
    const root = document.createElement('div');
    root.classList.add('pw-dialog');

    root.innerHTML = `
        <h3 class="pw-title">Alter — стартовая точка персонажа</h3>
        <input type="text" class="text_pole pw-review-title" placeholder="Название страницы">
        <textarea class="text_pole pw-review-text" rows="16">${escapeHtml(text)}</textarea>
        <div class="pw-footer">
            <button class="menu_button pw-btn-lg pw-save-btn">
                <i class="fa-solid fa-floppy-disk"></i>
                Сохранить в Sketchbook
            </button>
        </div>
    `;

    const context = ctx();
    const popup = new context.Popup(root, context.POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        okButton: false,
        cancelButton: 'Закрыть',
    });

    $(root).on('click', '.pw-save-btn', () => {
        const finalText = $(root).find('.pw-review-text').val();
        const title = $(root).find('.pw-review-title').val().trim();
        addPage({ title: title || undefined, text: finalText, kind: 'persona' });
        toastr.success('Сохранено в Sketchbook.', 'Alter');
        popup.complete(context.POPUP_RESULT.AFFIRMATIVE);
    });

    await popup.show();
}

/** Открывает окно Alter — маленький опросник для стартовой точки персонажа. */
export async function openAlter() {
    const root = document.createElement('div');
    root.classList.add('pw-dialog');

    const draft = getAlterDraft();
    const loreNamesForForm = draft.loreNames.length ? draft.loreNames : [getDefaultCharacterLoreName()].filter(Boolean);

    root.innerHTML = `
        <h3 class="pw-title">Alter — стартовая точка персонажа</h3>
        <p class="pw-hint">
            Никаких готовых персонажей — просто набор имён, запахов, характеров и бэкграундов,
            чтобы собрать своего.
        </p>

        <div class="pw-question">
            <div class="pw-question-label">Пол/местоимения</div>
            <div class="pw-segmented">${segmentedRowHtml('gender', GENDER_OPTIONS, draft.gender)}</div>
        </div>

        <div class="pw-question">
            <div class="pw-question-label">Раса/вид</div>
            <div class="pw-question-hint">Пиши как хочешь — модель учтёт это в фоне и запахе (если он выбран).</div>
            <input type="text" class="text_pole pw-alter-species" placeholder="Например: омега, демон, эльф..." value="${escapeHtml(draft.species)}">
        </div>

        <div class="pw-question">
            <div class="pw-question-label">Феромоны/запах</div>
            <div class="pw-chip-row" id="pw-alter-pheromones">${chipRowHtml('pheromones', PHEROMONE_OPTIONS, draft.pheromoneIds)}</div>
        </div>

        <div class="pw-question">
            <label class="pw-toggle">
                <input type="checkbox" class="pw-alter-avoid-names" ${draft.avoidNames !== false ? 'checked' : ''}>
                <span>Избегать уже занятых имён (${getAllPersonaNames().length} персон в библиотеке)</span>
            </label>
        </div>

        <div class="pw-question">
            <div class="pw-question-label">Связь с ботом/сюжетом</div>
            <div class="pw-question-hint">Канон для всех вариантов бэкграунда, а не один пункт. Отдельным блоком в выводе не станет.</div>
            <textarea class="text_pole pw-alter-connection" rows="2" placeholder="Например: детство вместе, случайная встреча, похищен...">${escapeHtml(draft.connection)}</textarea>
        </div>

        <div class="pw-question">
            <div class="pw-question-label">Свободные заметки и хотелки</div>
            <textarea class="text_pole pw-alter-notes" rows="3" placeholder="Всё, что не влезло выше...">${escapeHtml(draft.notes)}</textarea>
        </div>

        <div class="pw-question">
            <div class="pw-question-label">Не хочу видеть</div>
            <div class="pw-question-hint">Через запятую. Общий для всех чатов, уходит модели как запрет.</div>
            <textarea class="text_pole pw-alter-stoplist" rows="2" placeholder="Например: каяк, покер, кошки...">${escapeHtml(getAlterStopList())}</textarea>
        </div>

        <div class="pw-question">
            <div class="pw-question-label">Роль юзера задана в карточке?</div>
            <div class="pw-question-hint">Да — роль берётся из карточки и первого сообщения, меняются характер и детали. Нет — персона выдумывается с нуля.</div>
            <div class="pw-segmented">${segmentedRowHtml('roleCanon', ROLE_CANON_OPTIONS, draft.roleCanon)}</div>
        </div>

        <div class="pw-question">
            <div class="pw-question-label">Сколько выдумывать</div>
            <div class="pw-segmented">${segmentedRowHtml('invention', INVENTION_OPTIONS, draft.invention)}</div>
        </div>

        <div class="pw-generation-settings">
            ${modelSectionHtml(draft.profileId)}
            <div class="pw-question">
                <div class="pw-question-label">Какие лорбуки</div>
                ${loreSelectHtml(loreNamesForForm)}
            </div>
        </div>

        <div class="pw-footer">
            <button class="menu_button pw-btn-lg pw-alter-cancel-btn" style="display: none;">
                <i class="fa-solid fa-xmark"></i>
                Отмена
            </button>
            <div class="pw-footer-right">
                <button class="menu_button pw-generate-btn pw-alter-generate-btn">
                    <i class="fa-solid fa-wand-magic-sparkles"></i>
                    Сгенерировать
                </button>
            </div>
        </div>
    `;

    // Собирает текущее состояние формы и сохраняет его как черновик Alter.
    const persistAlterDraft = () => {
        saveAlterDraftDebounced({
            gender: $(root).find('.pw-alter-seg[data-name="gender"][aria-pressed="true"]').data('value') || 'male',
            species: $(root).find('.pw-alter-species').val().trim(),
            pheromoneIds: $(root).find('#pw-alter-pheromones .pw-chip--active').map(function () { return $(this).data('value'); }).get(),
            connection: $(root).find('.pw-alter-connection').val(),
            notes: $(root).find('.pw-alter-notes').val(),
            invention: $(root).find('.pw-alter-seg[data-name="invention"][aria-pressed="true"]').data('value') || 'balanced',
            roleCanon: $(root).find('.pw-alter-seg[data-name="roleCanon"][aria-pressed="true"]').data('value') || 'yes',
            profileId: $(root).find('.pw-model-select').val() || '',
            loreNames: $(root).find('.pw-lore-checkbox:checked').map(function () { return $(this).val(); }).get(),
            avoidNames: $(root).find('.pw-alter-avoid-names').prop('checked'),
        });
    };

    // Чипы феромонов — множественный выбор, без лимита.
    $(root).on('click', '.pw-chip', function () {
        $(this).toggleClass('pw-chip--active');
        persistAlterDraft();
    });

    // Сегментированные ряды (пол, сколько выдумывать) — один активный в своей группе.
    $(root).on('click', '.pw-alter-seg', function () {
        const $btn = $(this);
        $btn.siblings(`[data-name="${$btn.data('name')}"]`).attr('aria-pressed', 'false');
        $btn.attr('aria-pressed', 'true');
        persistAlterDraft();
    });

    // Поиск по списку лорбуков — прячет несовпавшие строки, галки не трогает.
    $(root).on('input', '.pw-lore-search', function () {
        const query = String($(this).val() || '').trim().toLowerCase();
        $(root).find('.pw-lore-item').each(function () {
            const text = $(this).find('.pw-lore-name').text().trim().toLowerCase();
            $(this).toggle(!query || text.includes(query));
        });
    });

    // Любое изменение текстовых полей/модели/лорбуков/тумблера имён — тоже сохраняем.
    // Стоп-лист — общий для всех чатов, поэтому мимо черновика чата.
    $(root).on('input', '.pw-alter-stoplist', function () {
        setAlterStopList($(this).val());
    });

    $(root).on('input change', '.pw-alter-species, .pw-alter-connection, .pw-alter-notes, .pw-model-select, .pw-lore-checkbox, .pw-alter-avoid-names', persistAlterDraft);

    let activeAbort = null;
    let activeUsesProfile = false;
    let popupClosed = false;

    $(root).on('click', '.pw-alter-generate-btn', async () => {
        const gender = $(root).find('.pw-alter-seg[data-name="gender"][aria-pressed="true"]').data('value') || 'male';
        const invention = $(root).find('.pw-alter-seg[data-name="invention"][aria-pressed="true"]').data('value') || 'balanced';
        const roleCanon = ($(root).find('.pw-alter-seg[data-name="roleCanon"][aria-pressed="true"]').data('value') || 'yes') === 'yes';
        const species = $(root).find('.pw-alter-species').val().trim();
        const connection = $(root).find('.pw-alter-connection').val().trim();
        const notes = $(root).find('.pw-alter-notes').val().trim();
        const pheromoneIds = $(root).find('#pw-alter-pheromones .pw-chip--active').map(function () {
            return $(this).data('value');
        }).get();
        const pheromoneLabels = PHEROMONE_OPTIONS
            .filter((opt) => pheromoneIds.includes(opt.id))
            .map((opt) => opt.labelEn);
        const profileId = $(root).find('.pw-model-select').val() || '';
        const loreNames = $(root).find('.pw-lore-checkbox:checked').map(function () { return $(this).val(); }).get();

        const $generateBtn = $(root).find('.pw-alter-generate-btn');
        const $cancelBtn = $(root).find('.pw-alter-cancel-btn');
        $generateBtn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Идёт генерация...');
        $cancelBtn.show();

        const abortController = new AbortController();
        activeAbort = abortController;
        activeUsesProfile = Boolean(profileId);

        try {
            const genderLabel = GENDER_OPTIONS.find((o) => o.id === gender)?.label || 'Male';
            const contextText = await buildContext({
                useCard: true,
                usePersona: false,
                useLore: true,
                loreNames,
                useHistory: true,
                historyCount: 1,
            });

            const prompt = buildAlterPrompt({
                contextText,
                gender: genderLabel,
                species,
                pheromoneLabels,
                notes,
                connection,
                invention,
                avoidNames: $(root).find('.pw-alter-avoid-names').prop('checked') ? getAllPersonaNames() : [],
                seeds: pickAlterSeeds(),
                lastGen: getAlterLast(),
                stopList: getAlterStopList(),
                roleCanon,
            });

            const text = await runGeneration({
                prompt,
                profileId,
                responseLength: 4096,
                signal: abortController.signal,
            });

            // Запоминаем имена и типы: следующий ген в этом чате их не повторит.
            const parsed = parseAlterResult(text);
            if (parsed.names.length || parsed.types.length || parsed.bullets.length) saveAlterLast(parsed);

            if (popupClosed) {
                addPage({ text, kind: 'persona' });
                toastr.success('Готово и сохранено в Sketchbook.', 'Alter');
            } else {
                openAlterResult(text);
            }
        } catch (error) {
            if (error?.name === 'AbortError') {
                toastr.info('Генерация отменена.', 'Alter');
            } else {
                console.error('[Plotweaver] ошибка генерации Alter', error);
                toastr.error(String(error?.message || error), 'Alter: не удалось сгенерировать');
            }
        } finally {
            activeAbort = null;
            $generateBtn.prop('disabled', false).html('<i class="fa-solid fa-wand-magic-sparkles"></i> Сгенерировать');
            $cancelBtn.hide();
        }
    });

    $(root).on('click', '.pw-alter-cancel-btn', () => {
        if (!activeAbort) return;
        activeAbort.abort(new DOMException('Cancelled by user', 'AbortError'));
        if (!activeUsesProfile) stopMainApiGeneration();
    });

    const context = ctx();
    const popup = new context.Popup(root, context.POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        okButton: false,
        cancelButton: 'Закрыть',
    });

    const closePromise = popup.show();
    closePromise.then(() => { popupClosed = true; });
    await closePromise;
}
