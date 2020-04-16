//@ts-check
'use strict';

const toml = require('toml');
const fs = require('fs')
const { Octokit } = require("@octokit/rest");
const os = require('os')

const omnifocus = require('./omnifocus')

// PotentialTask is the internal representation of a potential task
// to be added to OmniFocus.
class PotentialTask {
    constructor() {
        /** @type {string} */
        this.prefix;
        /** @type {string} */
        this.title;
        /** @type {string} */
        this.body;
    }
}

// CurrentTask is the internal representation of a current task
// from OmniFocus.
class CurrentTask {
    constructor() {
        /** @type {string} */
        this.id;
        /** @type {string} */
        this.title;
    }
}


async function main() {

    const config = loadConfig()

    console.log("Config loaded.")
    console.log(`Using API server: ${config.github.api_url}`);
    console.log(`Using token: ${config.github.auth_token}`);

    // TODO make config items?
    const newTaskTag = "github";
    const omnifocusPrsProject = 'GitHub PRs';
    const omnifocusIssuesProject = 'GitHub Issues';

    const octokit = new Octokit({
        auth: config.github.auth_token, // token
        userAgent: "github-to-omnifocus/1.0.0",
        baseUrl: config.github.api_url,
        log: console,
    })

    // Get issues and transform to standard form for tasks in "GitHub Issues" project
    // TODO use octokit's paginate to get more than 30 results
    try {
        const results = await octokit.issues.list({
            filter: "assigned",
            state: "open"
        })
        const issues = results.data.map(iss => {
            const prefix = iss.repository.full_name + "#" + iss.number
            const potentialTask = new PotentialTask()
            potentialTask.prefix = prefix
            potentialTask.title = `${prefix} ${iss.title}`
            potentialTask.body = iss.html_url
            return potentialTask
        })

        console.log(`Found ${issues.length} assigned issues.`)

        var tasks = await omnifocus.tasksForProject(omnifocusIssuesProject)
        tasks = tasks.map(t => {
            const task = new CurrentTask()
            task.id = t.id
            task.title = t.name
            return task
        })

        await addNewIssues(omnifocusIssuesProject, newTaskTag, tasks, issues)
        console.log("Issues added!")

        await completeMissingIssues(tasks, issues)
        console.log("Issues removed!")

    } catch (err) {
        console.error(err)
    }

    // Get PRs and transform to standard form for tasks in "GitHub PRs" project
    // TODO use octokit's paginate to get more than 30 results
    try {
        const user = await octokit.users.getAuthenticated()
        const username = user.data.login
        const prefix = t => { // pull the org and repo from the html_url via regex
            const m = t.html_url.match(/^https:\/\/github[^\0]ibm[^\0]com\/([^\/]+)\/([^\/]+)/m)
            return `${m[1]}/${m[2]}#${t.number}`
        }
        const results = await octokit.search.issuesAndPullRequests({
            q: `type:pr org:cloudant state:open review-requested:${username}`,
        });
        const prs = results.data.items.map(pr => {
            const potentialTask = new PotentialTask()
            potentialTask.prefix = prefix(pr)
            potentialTask.title = `${prefix(pr)} ${pr.title}`
            potentialTask.body = pr.html_url
            return potentialTask
        })

        console.log(`Found ${prs.length} PRs to review.`)

        var tasks = await omnifocus.tasksForProject(omnifocusPrsProject)
        tasks = tasks.map(t => {
            const task = new CurrentTask()
            task.id = t.id
            task.title = t.name
            return task
        })

        await addNewIssues(omnifocusPrsProject, newTaskTag, tasks, prs)
        console.log("PRs added!")

        await completeMissingIssues(tasks, prs)
        console.log("PRs removed!")
    } catch (err) {
        console.error(err)
    }
}

/**
 * addNewIssues makes new tasks for `issues` which have no task in
 * `currentTasks`.
 * @param {string} [omnifocusProject]
 * @param {string} ofTag
 * @param {CurrentTask[]} [currentTasks] {id, name}
 * @param {PotentialTask[]} [issues]
 */
async function addNewIssues(omnifocusProject, ofTag, currentTasks, issues) {

    try {
        // Filter down list of active assigned issues to those which do
        // not have a corresponding task (via prefix matching). Add these
        // issues as new tasks.
        const addTaskPromises = issues
            .filter(iss => {
                return !currentTasks.some(e => e.title.startsWith(iss.prefix))
            })
            .map(iss => {
                console.log("Adding issue: " + iss.prefix)
                return omnifocus.addNewTask(omnifocusProject, iss.title, ofTag, iss.body)
            })

        console.log("Waiting for " + addTaskPromises.length + " tasks to be added...")
        await Promise.all(addTaskPromises)

    } catch (err) {
        console.error(err.message)
    }
}

/**
 * completeMissingIssues marks tasks in `currentTasks` complete which have
 * no corresponding issue in `issues`.
 * @param {CurrentTask[]} [currentTasks] {id, name}
 * @param {PotentialTask[]} [issues]
 */
async function completeMissingIssues(currentTasks, issues) {

    // Generate list of prefixes that we use for tasks within
    // OmniFocus, which will allow us to figure out which tasks
    // are no longer in issues, so we can remove them.
    const issuePrefixes = issues.map(iss => iss.prefix)

    try {
        // Filter down to list of tasks where there is no corresponding
        // issue currently assigned to us via prefix matching, then
        // mark them complete.
        var removeTaskPromises = currentTasks
            .filter((t) => !issuePrefixes.some(e => t.title.startsWith(e)))
            .map((t) => {
                console.log("Mark complete: " + t.title)
                return omnifocus.markTaskComplete(t.id)
            })

        console.log(`Waiting for ${removeTaskPromises.length} tasks to be completed...`)
        await Promise.all(removeTaskPromises)
    } catch (err) {
        console.log(err);
    }
}

function loadConfig() {
    var tomlConfig, config

    var configFilePath = `${os.homedir()}/.github-to-omnifocus.toml`
    console.log(`Reading config at ${configFilePath}...`)

    try {
        tomlConfig = fs.readFileSync(configFilePath, 'utf8')
    } catch (err) {
        console.error(err)
        process.exit(1)
    }

    try {
        config = toml.parse(tomlConfig);
    } catch (e) {
        console.error("Parsing error on line " + e.line + ", column " + e.column +
            ": " + e.message);
        process.exit(1)
    }

    return config
}

main()
