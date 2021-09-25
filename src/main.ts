import * as core from '@actions/core'
import {Octokit} from 'octokit'
import YAML from 'yaml'
import GetDateFormatted from './utils'

async function run(): Promise<void> {
  core.info('Starting')
  try {
    // used during local running
    process.env.PAT = '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'
    process.env.GITHUB_USER = 'rajbos'

    const PAT = core.getInput('PAT') || process.env.PAT || ''
    const user = core.getInput('user') || process.env.GITHUB_USER || ''
    const organization =
      core.getInput('organization') || process.env.GITHUB_ORGANIZATION || ''

    if (!PAT || PAT === '') {
      core.setFailed(
        "Parameter 'PAT' is required to load all actions from the organization or user account"
      )
      return
    }

    if (user === '' && organization === '') {
      core.setFailed(
        "Either parameter 'user' or 'organization' is required to load all actions from it. Please provide one of them."
      )
      return
    }

    const octokit = new Octokit({auth: PAT})

    try {
      const currentUser = await octokit.rest.users.getAuthenticated()

      core.info(`Hello, ${currentUser.data.login}`)
    } catch (error) {
      core.setFailed(
        `Could not authenticate with PAT. Please check that it is correct and that it has [read access] to the organization or user account: ${error}`
      )
      return
    }

    const repos = await findAllRepos(octokit, user, organization)
    console.log(`Found [${repos.length}] repositories`)

    let actionFiles = await findAllActions(octokit, repos)
    // load the information in the files
    actionFiles = await enrichActionFiles(octokit, actionFiles)

    // output the json we want to output
    const output: {
      lastUpdated: string
      actions: Content[]
    } = {
      lastUpdated: GetDateFormatted(new Date()),
      actions: actionFiles
    }

    const json = JSON.stringify(output)
    core.setOutput('actions', JSON.stringify(json))
  } catch (error) {
    core.setFailed(`Error running action: : ${error.message}`)
  }
}

//todo: move this function to a separate file, with the corresponding class definition
async function findAllRepos(
  client: Octokit,
  username: string,
  organization: string
): Promise<Repository[]> {
  // todo: switch between user and org

  // convert to an array of objects we can return
  const result: Repository[] = []

  if (username !== '') {
    const repos = await client.paginate(client.rest.repos.listForUser, {
      username
    })

    core.info(`Found [${repos.length}] repositories`)

    // eslint disabled: no iterator available
    // eslint-disable-next-line @typescript-eslint/prefer-for-of
    for (let num = 0; num < repos.length; num++) {
      const repo = repos[num]
      const repository = new Repository(repo.owner?.login || '', repo.name) //todo: handle for orgs
      result.push(repository)
    }
  }

  if (organization !== '') {
    const repos = await client.paginate(client.rest.repos.listForOrg, {
      org: organization
    })

    console.log(`Found [${organization}] as orgname parameter`)
    core.info(`Found [${repos.length}] repositories`)

    // eslint disabled: no iterator available
    // eslint-disable-next-line @typescript-eslint/prefer-for-of
    for (let num = 0; num < repos.length; num++) {
      const repo = repos[num]
      const repository = new Repository(repo.owner?.login || '', repo.name) //todo: handle for orgs
      result.push(repository)
    }
  }

  return result
}

class Repository {
  name: string
  owner: string
  constructor(owner: string, name: string) {
    this.name = name
    this.owner = owner
  }
}

class Content {
  name = ``
  repo = ``
  downloadUrl = ``
  author = ``
  description = ``
}

async function findAllActions(
  client: Octokit,
  repos: Repository[]
): Promise<Content[]> {
  // create array
  const result: Content[] = []

  // search all repos for actions
  for (const repo of repos) {
    core.debug(`Searching repository for actions: ${repo.name}`)
    const content = await getActionFile(client, repo)
    if (content && content.name !== '') {
      core.info(
        `Found action file in repository: ${repo.name} with filename [${content.name}] download url [${content.downloadUrl}]`
      )
      // add to array
      result.push(content)
    }
  }

  console.log(`Found [${result.length}] actions in [${repos.length}] repos`)
  return result
}

async function getActionFile(
  client: Octokit,
  repo: Repository
): Promise<Content | null> {
  const result = new Content()

  // search for action.yml file in the root of the repo
  try {
    const {data: yml} = await client.rest.repos.getContent({
      owner: repo.owner,
      repo: repo.name,
      path: 'action.yml'
    })

    // todo: warning: duplicated code here
    if ('name' in yml && 'download_url' in yml) {
      result.name = yml.name
      result.repo = repo.name
      if (yml.download_url !== null) {
        result.downloadUrl = yml.download_url
      }
    }
  } catch (error) {
    core.debug(`No action.yml file found in repository: ${repo.name}`)
  }

  if (result.name === '') {
    try {
      // search for the action.yaml, that is also allowed
      const {data: yaml} = await client.rest.repos.getContent({
        owner: repo.owner,
        repo: repo.name,
        path: 'action.yaml'
      })

      if ('name' in yaml && 'download_url' in yaml) {
        result.name = yaml.name
        result.repo = repo.name
        if (yaml.download_url !== null) {
          result.downloadUrl = yaml.download_url
        }
      }
    } catch (error) {
      core.debug(`No action.yaml file found in repository: ${repo.name}`)
    }
  }

  if (result.name === '') {
    core.info(`No actions found in repository: ${repo.name}`)
    return null
  }

  return result
}

async function enrichActionFiles(
  client: Octokit,
  actionFiles: Content[]
): Promise<Content[]> {
  for (const action of actionFiles) {
    // download the file in it and parse it
    if (action.downloadUrl !== null) {
      const {data: content} = await client.request({url: action.downloadUrl})

      // try to parse the yaml
      try {
        const parsed = YAML.parse(content)
        action.name = parsed.name
        action.author = parsed.author
        action.description = parsed.description
      } catch (error) {
        // this happens in https://github.com/gaurav-nelson/github-action-markdown-link-check/blob/9de9db77de3b29b650d2e2e99f0ee290f435214b/action.yml#L9
        // because of invalid yaml
        console.log(
          `Error parsing action file in repo [${action.repo}] with error:`
        )
        console.log(error)
        console.log(
          `The parsing error is informational, seaching for actions has continued`
        )
      }
    }
  }
  return actionFiles
}

run()
