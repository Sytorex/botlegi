import * as cheerio from "cheerio";
import { Client, EmbedBuilder, GatewayIntentBits, TextChannel } from "discord.js";
import * as dotenv from "dotenv";
import { promises as fs } from "fs";
import cron from 'node-cron';
import * as path from "path";
import puppeteer from "puppeteer";
dotenv.config({ quiet: true });

const DEFAULT_LEGI_URL = "https://www.legifrance.gouv.fr/";
const DEFAULT_CHRONO_LEGI_URL: string = "https://www.legifrance.gouv.fr/chronolegi?cidText=LEGITEXT000006071191&libText=-&type=CODE&navigation=true";
const PING_OWNER = true;
const SEND_IF_NO_CHANGE = true;
const EMBED_COLOR = 0xED938E;
const MAX_DESC_LENGTH = 4000;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages
    ],
});

interface Article {
    articleNumbers: string[];
    articleUrls: string[];
    sectionName: string;
    sectionUrl: string;
}

interface ModificationItem {
    title: string;
    url: string;
    action: string; // "A modifié", "A créé", etc.
    articles: Article[];
}

interface ParsedData {
    date: string;
    dateUrl: string;
    modifications: ModificationItem[];
}

interface LegiLog {
    log_date: string;
    versionItems: {
        isCurrentVersion: boolean;
        dateLink: string;
        savedHtml: string;
    }[];
}

const observedLogs: LegiLog[] = [];
const LOGS_FILE_PATH = path.join(__dirname, 'observed_logs.json');

console.log("Bot is starting...");
console.log(LOGS_FILE_PATH);

/**
 * Charge les logs depuis le fichier JSON s'il existe
 */
async function loadLogs(): Promise<void> {
    try {
        // Crée le fichier s'il n'existe pas
        await fs.access(LOGS_FILE_PATH).catch(async () => {
            await fs.writeFile(LOGS_FILE_PATH, "[]", "utf-8");
        });

        const data = await fs.readFile(LOGS_FILE_PATH, "utf-8");
        const logs = JSON.parse(data);
        observedLogs.push(...logs);
        console.log(`Loaded ${logs.length} logs from file`);
    } catch (error) {
        // Fichier n'existe pas encore ou erreur de lecture
        console.log("No existing logs file found, starting fresh");
    }
}

/**
 * Sauvegarde les logs dans le fichier JSON
 */
async function saveLogs(): Promise<void> {
    try {
        await fs.writeFile(LOGS_FILE_PATH, JSON.stringify(observedLogs, null, 2), "utf-8");
        console.log(`Saved ${observedLogs.length} logs to file`);
    } catch (error) {
        console.error("Error saving logs:", error);
    }
}

client.once("clientReady", async () => {
    console.log(`Logged as ${client.user?.tag}`);

    // Charger les logs existants
    await loadLogs();

    // On programme la tâche cron pour s'exécuter tous les jours à 22h00
    cron.schedule('0 22 * * *', async () => {
        const channel = await client.channels.fetch(process.env.CHANNEL_ID!);
        if (channel != null && channel instanceof TextChannel && channel.isTextBased()) {            
            processLegiUpdates(channel);
        }
    }, {
        timezone: "Europe/Paris"
    });

    // On programme une tâche cron toute les heures pour vérifier les modifications en temps réel
    cron.schedule('0 * * * *', async () => {
        const channel = await client.channels.fetch(process.env.CHANNEL_ID!);
        if (channel != null && channel instanceof TextChannel && channel.isTextBased()) {            
            processLogUpdates(channel);
        }
    }, {
        timezone: "Europe/Paris"
    });

    const channel = await client.channels.fetch(process.env.CHANNEL_ID!);
        
});

/**
 * Scrape la page ChronoLégi pour obtenir le HTML brut
 */
async function scrapeChronoLegi() {
    // Obtenir la date actuelle au format YYYY-MM-DD
    const today = new Date().toISOString().split('T')[0];

    // Construire l'URL avec les paramètres de date
    const url = `${DEFAULT_CHRONO_LEGI_URL}&startYear=${today}&endYear=${today}&dateConsult=${today}`;

    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        const page = await browser.newPage();

        // Configurer le User-Agent
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');

        // Aller sur la page
        await page.goto(url, {
            waitUntil: "networkidle2",
            timeout: 30000
        });

        // Attendre que le contenu soit chargé
        await page.waitForSelector('body');

        const content = await page.content();
        return content;

    } finally {
        await browser.close();
    }
}

/**
 * Parse le HTML brut de ChronoLégi pour extraire les modifications légales
 */
function parseLegiData(rawHTML: string): ParsedData | null {
    const $ = cheerio.load(rawHTML);
    
    // Vérifier si il y a une version aujourd'hui
    const today = new Date();
    const todayFormatted = `${today.getDate().toString().padStart(2, '0')}/${(today.getMonth() + 1).toString().padStart(2, '0')}/${today.getFullYear()}`;
    if ($(`.version-item a[data-date='${todayFormatted}']`).length === 0) {
        console.log(`No version for today ${todayFormatted}`);
        console.log($('.version-item a').html());
        return null;
    }

    // Trouver le conteneur de la version actuelle
    const container = $(".version-item.current-version").first();
    if (!container.length) {
        console.log("Container not found");
        return null;
    }
    
    // Extraire la date
    const dateLink = container.find(".detail-timeline-title a");
    const date = dateLink.text().trim();
    const dateUrl = "https://www.legifrance.gouv.fr" + dateLink.attr("href");
    
    const modifications: ModificationItem[] = [];
    
    // Parcourir chaque modification
    container.find(".content-detail-timeline").each((_, modifEl) => {
        const $modif = $(modifEl);

        // Titre de la modification (LOI, Décret, etc.)
        const titleLink = $modif.find("h4.txt-title a");
        if (titleLink.length === 0) return;
        const title = titleLink.text().trim();
        const url = DEFAULT_LEGI_URL + titleLink.attr("href");
        
        // Action (A modifié, A créé, etc.)
        const action = $modif.find(".tag-state-small").text().trim();
        
        const articles: Article[] = [];
        
        // Parcourir chaque groupe d'articles
        $modif.find(".list-item").each((_, itemEl) => {
            const $item = $(itemEl);
            
            const articleNumbers: string[] = [];
            const articleUrls: string[] = [];
            
            // Récupérer les numéros d'articles
            $item.find(".list-arcticle-chrono li a").each((_, artEl) => {
                articleNumbers.push($(artEl).text().trim());
                articleUrls.push(DEFAULT_LEGI_URL + $(artEl).attr("href"));
            });
            
            // Récupérer la section
            const sectionLink = $item.find("a[href*='section_lc']");
            const sectionName = sectionLink.text().trim();
            const sectionUrl = DEFAULT_LEGI_URL + sectionLink.attr("href");
            
            articles.push({
                articleNumbers,
                articleUrls,
                sectionName,
                sectionUrl
            });
        });
        
        modifications.push({
            title,
            url,
            action,
            articles
        });
    });
    
    return {
        date,
        dateUrl,
        modifications
    };
}

/**
 * Formate les données extraites en embeds Discord
 */
function formatEmbeds(data: ParsedData): EmbedBuilder[] {
    const embeds: EmbedBuilder[] = [];
    
    let currentEmbed = new EmbedBuilder()
        .setTitle(`📅 ${data.date}`)
        .setURL(data.dateUrl)
        .setColor(EMBED_COLOR)
        .setTimestamp();
    
    let currentDescription = "";
    
    for (const modif of data.modifications) {
        // Construire le contenu de cette modification
        const actionEmoji = modif.action.includes("modifié") ? "📝" : 
                           modif.action.includes("créé") ? "✨" : 
                           modif.action.includes("abrogé") ? "❌" : "📄";
        
        let modifContent = `\n### ${actionEmoji} [${modif.title}](${modif.url})`;
        modifContent += `\n*${modif.action}*\n`;
        
        for (const articleGroup of modif.articles) {
            const articlesLinks = articleGroup.articleNumbers.map((num, idx) => 
                `[${num}](${articleGroup.articleUrls[idx]})`
            ).join(", ");
            
            modifContent += `• Article ${articlesLinks}`;
            if (articleGroup.sectionName) {
                modifContent += ` - [${articleGroup.sectionName}](${articleGroup.sectionUrl})`;
            }
            modifContent += "\n";
        }
        
        // Vérifier si l'ajout dépasse la limite
        if ((currentDescription + modifContent).length > MAX_DESC_LENGTH) {
            // Sauvegarder l'embed actuel et en créer un nouveau
            currentEmbed.setDescription(currentDescription);
            embeds.push(currentEmbed);
            
            currentEmbed = new EmbedBuilder()
                .setTitle(`📅 ${data.date} (suite)`)
                .setURL(data.dateUrl)
                .setColor(EMBED_COLOR)
                .setTimestamp();
            
            currentDescription = modifContent;
        } else {
            currentDescription += modifContent;
        }
    }
    
    // Ajouter le dernier embed s'il contient du contenu
    if (currentDescription.length > 0) {
        currentEmbed.setDescription(currentDescription);
        embeds.push(currentEmbed);
    }
    
    return embeds;
}

/**
 * Processus principal pour récupérer, parser et envoyer les mises à jour légales
 */
async function processLegiUpdates(channel: TextChannel): Promise<void> {
    const htmlContent = await scrapeChronoLegi();
    const legiData = parseLegiData(htmlContent);
    console.log(legiData);
    
    // Si des modifications légales sont détectées, envoyer un message avec l'embed
    if (legiData) {
        const embeds = formatEmbeds(legiData);

        for (let i = 0; i < embeds.length; i++) {
            const content = (PING_OWNER && process.env.OWNER_ID && i === 0) ? `<@${process.env.OWNER_ID}>` : undefined; // Mentionner le propriétaire si configuré
            await channel.send({ content, embeds: [embeds[i]] });
        }

    // Sinon, envoyer un message indiquant qu'il n'y a pas de modifications
    } else {
        const msgContent = "Aucune modification légale détectée aujourd'hui";
        console.log(msgContent + ` ${new Date().toISOString().split('T')[0]}`);
        if (SEND_IF_NO_CHANGE) await channel.send(msgContent); // Envoyer sur discord seulement si configuré
    }
}

// Chaque heure, on observe si sur le site il y a eu des modification dans accordion-timeline-item[data-year="2026"] #expand_1 .version-item
// Si oui, on scrape les données et on envoie un message Discord avec la dateUrl
// Et surtout on log dans une base de données pour éviter les doublons (log_date = date du jour avec heure, dateUrl = url de la page de la version du jour)
// Le but final est d'avoir l'information de l'heure à laquelle les modifications ont été publiées
async function processLogUpdates(channel: TextChannel): Promise<void> {
    const htmlContent = await scrapeChronoLegi();
    
    // Parse le HTML pour trouver la version du jour
    const $ = cheerio.load(htmlContent);

    const container = $(".accordion-timeline-item[data-year='2026'] #expand_1");
    // On récupère l'ensemble des version item
    const versionItems = container.find(".version-item");

    if (versionItems.length === 0) {
        console.log("No version items found in log update");
        return;
    }

    const formatedVersionItems = versionItems.map((_, el) => {
        const versionItem = $(el);
        const dateLinkHtml = versionItem.find(".detail-timeline-title a");

        return {
            isCurrentVersion: versionItem.hasClass("current-version"),
            dateLink: dateLinkHtml.html() ? "https://www.legifrance.gouv.fr" + dateLinkHtml.attr("href") : "",
            savedHtml: versionItem.html() || ""
        };
    }).get();

    try {
        if (observedLogs.length > 0 && observedLogs[observedLogs.length - 1].versionItems.length < formatedVersionItems.length) {
            // On envoie un message Discord pour chaque nouveau log
            const content = `Nouvelle modification détectée <@410774625820082176>`;
            channel.send(content);
        }
    } catch (error) {
        console.error("Error sending log update message:", error);
    }

    observedLogs.push({
        log_date: new Date().toISOString(),
        versionItems: formatedVersionItems
    });

    // Sauvegarder les logs dans le fichier JSON
    await saveLogs();
}

client.login(process.env.DISCORD_TOKEN!);