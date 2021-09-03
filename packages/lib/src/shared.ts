import { PluginHooks } from '../types/pluginHooks'
import { findDependencies, getModuleMarker, sharedAssign } from './utils'
import {
  builderInfo,
  EXPOSES_CHUNK_SET,
  MODULE_NAMES,
  ROLLUP,
  SHARED
} from './public'
import MagicString from 'magic-string'
import { walk } from 'estree-walker'
import path from 'path'
import { VitePluginFederationOptions } from 'types'

export let sharedMap: Map<string, Map<string, any>> = new Map()

export function sharedPlugin(
  options: VitePluginFederationOptions
): PluginHooks {
  sharedAssign(sharedMap, options.shared || [])
  sharedMap.forEach((value, key) => {
    const sharedModuleName = getModuleMarker(`\${${key}}`, SHARED)
    MODULE_NAMES.push(sharedModuleName)
  })

  return {
    name: 'originjs:shared',

    options(inputOptions) {
      if (sharedMap.size) {
        // remove item which is both in external and shared
        inputOptions.external = (inputOptions.external as [])?.filter(
          (item) => {
            return !sharedMap.has(item)
          }
        )
        // add shared content into input
        sharedMap.forEach((value, key) => {
          inputOptions.input![`${getModuleMarker(key, 'input')}`] = key
          if (Array.isArray(inputOptions.external)) {
            inputOptions.external.push(
              getModuleMarker(`\${${key}}`, 'shareScope')
            )
          }
        })
      }
      return inputOptions
    },

    async buildStart(options) {
      for (const entry of sharedMap) {
        const key = entry[0]
        const value = entry[1]
        value.set('idRegexp', RegExp(`node_modules[/\\\\]@?${key}[/\\\\]`))
        value.set('id', await this.resolveId(key))
      }
    },

    outputOptions(outputOption) {
      const that = this
      const priority: string[] = []
      const depInShared = new Map()
      // set every shared used moduleIds
      sharedMap.forEach((value, key) => {
        // pick every shared moduleId
        const sharedModuleIds = new Map<string, string>()
        const usedSharedModuleIds = new Set<string>()
        sharedMap.forEach((value, key) =>
          sharedModuleIds.set(value.get('id'), key)
        )
        const moduleId = value.get('id')
        // remove itself
        sharedModuleIds.delete(moduleId)
        depInShared.set(key, usedSharedModuleIds)
        const deps = new Set<string>()
        findDependencies.apply(that, [
          moduleId,
          deps,
          sharedModuleIds,
          usedSharedModuleIds
        ])
        value.set('dependencies', deps)
      })
      // judge dependencies priority
      const orderByDepCount: Map<string, Set<string>>[] = []
      depInShared.forEach((value, key) => {
        if (!orderByDepCount[value.size]) {
          orderByDepCount[value.size] = new Map()
        }
        orderByDepCount[value.size].set(key, value)
      })

      // dependency nothing is first
      for (let i = 0; i < orderByDepCount.length; i++) {
        if (i === 0) {
          for (const key of orderByDepCount[i].keys()) {
            priority.push(key)
          }
        } else {
          for (const entries of orderByDepCount[i].entries()) {
            addDep(entries, priority, depInShared)
          }
        }
      }

      function addDep(entries, priority, depInShared) {
        const key = entries[0]
        const value = entries[1]
        for (const dep of value) {
          if (!priority.includes(dep)) {
            addDep([dep, depInShared.get(dep)], priority, depInShared)
          }
        }
        if (!priority.includes(key)) {
          priority.push(key)
        }
      }
      // adjust the map order according to priority
      const shareMapClone = new Map<string, Map<string, any>>()
      priority.forEach((item) => {
        const value = sharedMap.get(item)
        if (value) {
          shareMapClone.set(item, value)
        }
      })
      sharedMap = shareMapClone

      // only active when manualChunks is function,array not to solve
      if (typeof outputOption.manualChunks === 'function') {
        outputOption.manualChunks = new Proxy(outputOption.manualChunks, {
          apply(target, thisArg, argArray) {
            const id = argArray[0]
            //  if id is in shareMap , return id ,else return vite function value
            let find = ''
            for (const sharedMapElement of sharedMap) {
              const key = sharedMapElement[0]
              const value = sharedMapElement[1]
              if (value.get('dependencies')?.has(id)) {
                find = key
                break
              }
            }
            return find ? find : target(argArray[0], argArray[1])
          }
        })
      }
      return outputOption
    },

    generateBundle: function (options, bundle) {
      // Find out the real shared file
      for (const fileName in bundle) {
        const chunk = bundle[fileName]
        if (chunk.type === 'chunk' && chunk.isEntry) {
          const sharedName = chunk.name.match(/(?<=__rf_input__).*/)?.[0]
          if (sharedName) {
            let filePath = ''
            if (Object.keys(chunk.modules).length) {
              filePath = chunk.fileName
            } else {
              if (chunk.imports.length === 1) {
                filePath = chunk.imports[0]
              } else if (chunk.imports.length > 1) {
                filePath =
                  chunk.imports.find(
                    (item) => bundle[item].name === sharedName
                  ) ?? ''
              }
            }
            const fileName = path.basename(filePath)
            const fileDir = path.dirname(filePath)
            const sharedProp = sharedMap.get(sharedName)
            sharedProp?.set('fileName', fileName)
            sharedProp?.set('fileDir', fileDir)
            sharedProp?.set('filePath', filePath)
          }
        }
      }
      const importReplaceMap = new Map()
      // rename file and remove unnecessary file
      sharedMap.forEach((value, key) => {
        const fileName = value.get('fileName')
        const fileDir = value.get('fileDir')
        const filePath = value.get('filePath')
        if (filePath && !fileName.startsWith('__rf_input')) {
          const expectName = `__rf_input__${key}`
          let expectFileName = ''
          // find expectName
          for (const file in bundle) {
            if (bundle[file].name === expectName) {
              expectFileName = path.basename(bundle[file].fileName)
              break
            }
          }
          expectFileName = expectFileName ? expectFileName : `${expectName}.js`
          // rollup fileName
          const expectFilePath = `${fileDir}/${expectFileName}`
          // fileName or filePath,vite is filePath,rollup is filename
          const expectFileNameOrPath =
            builderInfo.builder === ROLLUP ? expectFileName : expectFilePath
          const fileNameOrPath =
            builderInfo.builder === ROLLUP ? fileName : filePath
          // delete non-used chunk
          delete bundle[expectFileNameOrPath]
          //  rename chunk
          bundle[expectFileNameOrPath] = bundle[fileNameOrPath]
          bundle[expectFileNameOrPath].fileName = expectFileNameOrPath
          delete bundle[fileNameOrPath]
          importReplaceMap.set(filePath, expectFilePath)
          value.set('filePath', expectFilePath)
          value.set('fileName', expectFileName)
        }
        importReplaceMap.set(
          getModuleMarker(`\${${key}}`, 'shareScope'),
          `./${value.get('fileName')}`
        )
      })

      // replace every chunk import
      importReplaceMap.forEach((value, key) => {
        for (const fileKey in bundle) {
          const chunk = bundle[fileKey]
          if (chunk.type === 'chunk') {
            const importIndexOf = chunk.imports.indexOf(key)
            if (importIndexOf >= 0) {
              chunk.imports[importIndexOf] = value
              chunk.code = chunk.code.replace(
                path.basename(key),
                path.basename(value)
              )
            }
            chunk.code = chunk.code.replace(key, value)
          }
        }
      })

      if (EXPOSES_CHUNK_SET.size) {
        const FN_IMPORT = getModuleMarker('import', 'fn')
        const VAR_GLOBAL = getModuleMarker('global', 'var')
        const VAR_MODULE_MAP = getModuleMarker('moduleMap', 'var')
        const VAR_SHARED = getModuleMarker('shared', 'var')
        const fileName2SharedName = new Map()
        sharedMap.forEach((value, key) => {
          fileName2SharedName.set(value.get('fileName'), key)
        })
        EXPOSES_CHUNK_SET.forEach((chunk) => {
          let lastImport: any = null
          const ast = this.parse(chunk.code)
          const importMap = new Map()
          const magicString = new MagicString(chunk.code)
          walk(ast, {
            enter(node: any) {
              if (node.type === 'ImportDeclaration') {
                const fileName = path.basename(node.source.value)
                const sharedName = fileName2SharedName.get(fileName)
                if (sharedName) {
                  importMap.set(sharedName, {
                    source: node.source.value,
                    specifiers: node.specifiers
                  })
                  //  replace import with empty
                  magicString.overwrite(node.start, node.end, '')
                }
                // record the last import to insert dynamic import code
                lastImport = node
              }
            }
          })
          //  generate variable declare
          const PLACEHOLDER_VAR = [...importMap.keys()]
            .map((item) => {
              let str = ''
              importMap.get(item).specifiers?.forEach((space) => {
                str += `let ${space.local.name} = (await ${FN_IMPORT}('${item}'))['${space.imported.name}'] \n`
              })
              return str
            })
            .join('')

          //    generate variable moduleMap declare
          const PLACEHOLDER_MODULE_MAP = `{${[...importMap.keys()]
            .map((item) => {
              return `'${item}':'${importMap.get(item).source}'`
            })
            .join(',')}}`
          // all insert code
          const dynamicCode = `\n
                    ${PLACEHOLDER_VAR}
                    async function ${FN_IMPORT} (name) {
                        let ${VAR_GLOBAL} = window || node;
                        const ${VAR_MODULE_MAP} = ${PLACEHOLDER_MODULE_MAP}
                        if (${VAR_GLOBAL}.${VAR_SHARED}?.[name]) {
							if (!${VAR_GLOBAL}.${VAR_SHARED}[name].lib) {
								${VAR_GLOBAL}.${VAR_SHARED}[name].lib = await (${VAR_GLOBAL}.${VAR_SHARED}[name].get())
							}
							return ${VAR_GLOBAL}.${VAR_SHARED}[name].lib;
						} else {
							return import(${VAR_MODULE_MAP}[name])
						}
                      }`

          if (lastImport) {
            //  append code after lastImport
            magicString.appendRight(lastImport.end, dynamicCode)
          }
          chunk.code = magicString.toString()
        })
      }
    }
  }
}
